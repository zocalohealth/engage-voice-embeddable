import { delegate, injectable, PortManager, RcModule, watch } from '@ringcentral-integration/next-core';
import { diagnosticAgentState, diagnosticLeadState } from '../../../lib/widgetDiagnostics';
import type { WidgetDiagnosticAction } from '../../../lib/widgetDiagnostics';
import { EvClient } from '../EvClient';
import { EvSubscription } from '../EvSubscription';
import { EvCallbackTypes } from '../EvClient/enums';
import { EvPresence } from '../EvPresence';
import { EvWorkingState } from '../EvWorkingState';
import { EvCall } from '../EvCall';
import { EvProgressiveDialer } from '../EvProgressiveDialer';
import { Adapter } from '../Adapter';

export type WidgetDiagnosticPayload = WidgetDiagnosticAction & {
  at: string;
  state?: ReturnType<EvWidgetDiagnostics['snapshot']>;
};

@injectable({ name: 'EvWidgetDiagnostics' })
export class EvWidgetDiagnostics extends RcModule {
  constructor(
    private evClient: EvClient,
    private evSubscription: EvSubscription,
    private evPresence: EvPresence,
    private evWorkingState: EvWorkingState,
    private evCall: EvCall,
    private progressiveDialer: EvProgressiveDialer,
    private adapter: Adapter,
    private portManager: PortManager,
  ) {
    super();
    let clientInitialized = false;
    let serverInitialized = false;
    const client = () => {
      if (clientInitialized) return;
      clientInitialized = true;
      this.evClient.addWidgetDiagnosticListener((action) => { void this.report(action).catch(() => {}); });
    };
    const server = () => {
      if (serverInitialized) return;
      serverInitialized = true;
      const events = [
        [EvCallbackTypes.NEW_CALL, 'call_started'], [EvCallbackTypes.END_CALL, 'call_ended'],
        [EvCallbackTypes.ADD_SESSION, 'session_added'], [EvCallbackTypes.DROP_SESSION, 'session_dropped'],
        [EvCallbackTypes.OPEN_SOCKET, 'socket_opened'], [EvCallbackTypes.CLOSE_SOCKET, 'socket_closed'],
        [EvCallbackTypes.OFFHOOK_TERM, 'offhook_ended'],
      ] as const;
      for (const [callback, event] of events) this.evSubscription.subscribe(callback, () => { void this.report({ event }).catch(() => {}); });
      this.evSubscription.subscribe(EvCallbackTypes.PREVIEW_LEAD_STATE, (data) => {
        void this.report({ event: 'lead_state', leadState: diagnosticLeadState(data?.leadState) }).catch(() => {});
      });
      this.evSubscription.subscribe(EvCallbackTypes.AGENT_STATE, (data) => {
        void this.report({ event: 'agent_state', command: 'agent_state', ackStatus: data?.status === 'OK' ? 'OK' : data?.status === 'FAIL' ? 'FAIL' : 'unknown' }).catch(() => {});
      });
      this.evSubscription.subscribe(EvCallbackTypes.ACK, (data) => {
        const commands = { HANGUP: 'hangup', ONE_TO_ONE_OUTDIAL_CANCEL: 'manual_cancel', 'ONE-TO-ONE-OUTDIAL-CANCEL': 'manual_cancel', 'OFF-HOOK-TERM': 'offhook_term', 'PREVIEW-DIAL': 'preview_dial' } as const;
        const command = Object.entries(commands).find(([key]) => key === data?.type)?.[1];
        if (!command) return;
        void this.report({ event: 'command_ack', command, ackStatus: data.status === 'OK' ? 'OK' : data.status === 'FAIL' ? 'FAIL' : 'unknown' }).catch(() => {});
      });
      watch(this, () => JSON.stringify(this.snapshot()), () => { void this.report({ event: 'state_changed' }).catch(() => {}); });
    };
    if (this.portManager.shared) {
      this.portManager.onMainTab(client);
      this.portManager.onServer(server);
    } else { client(); server(); }
  }

  snapshot(connection?: Awaited<ReturnType<EvClient['getWidgetDiagnosticState']>>) {
    return {
      agentState: diagnosticAgentState(this.evWorkingState.agentState?.agentState),
      dialing: !this.evCall.isIdle,
      offhook: this.evPresence.isOffhook,
      offhooking: this.evPresence.isOffhooking,
      activeCallCount: Math.min(this.evPresence.calls.length, 100),
      pendingDisposition: this.evWorkingState.isPendingDisposition,
      progressivePhase: this.progressiveDialer.phase,
      progressiveRunning: this.progressiveDialer.running,
      ...this.progressiveDialer.diagnosticState,
      sdkAgentState: connection?.sdkAgentState || 'unknown',
      socketReadyState: connection?.socketReadyState ?? null,
      sdkOnCall: connection?.sdkOnCall || false,
      sdkPendingDisposition: connection?.sdkPendingDisposition || false,
    };
  }

  @delegate('server')
  async report(action: WidgetDiagnosticAction): Promise<void> {
    const at = new Date().toISOString();
    const state = this.snapshot();
    try {
      const connection = await this.evClient.getWidgetDiagnosticState();
      await this.adapter.onDiagnostics({ ...action, at, state: { ...state, ...connection } });
    } catch {
      // Diagnostic delivery must never change the calling flow.
    }
  }
}
