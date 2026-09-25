import { action, delegate, injectable, PortManager, RcModule, state } from '@ringcentral-integration/next-core';
import { EvClient } from '../EvClient';
import { EvCallbackTypes, evStatus } from '../EvClient/enums';
import { EvAuth } from '../EvAuth';
import { EvAgentSession } from '../EvAgentSession';
import { EvPresence } from '../EvPresence';
import { EvWorkingState } from '../EvWorkingState';
import { EvCall } from '../EvCall';
import { EvLeads } from '../EvLeads';
import type { Lead } from '../EvLeads';
import { EvSettings } from '../EvSettings';
import { EvSubscription } from '../EvSubscription';
import { Adapter } from '../Adapter';

type Phase = 'stopped' | 'connecting' | 'fetching' | 'countdown' | 'waiting' | 'empty' | 'error';
const TERMINAL_LEAD_STATES = new Set(['NOANSWER', 'BUSY', 'MACHINE', 'HANGUP', 'INTERCEPT', 'DISCONNECT', 'ABANDON', 'CONGESTION', 'APP-DNC', 'OTHER']);

/** Runs on the shared server only; each start is invalidated by stop or a session change. */
@injectable({ name: 'EvProgressiveDialer' })
export class EvProgressiveDialer extends RcModule {
  @state running = false;
  @state phase: Phase = 'stopped';
  @state secondsUntilNextCall = 0;
  @state selectedLeadId = '';

  private generation = 0;
  private groupId = '';
  private timer?: ReturnType<typeof setInterval>;
  private deadline = 0;
  private fetching = false;
  private pendingRequest = '';
  private notificationLead?: Lead;
  private callUii = '';
  private sentAt = 0;
  private connected = false;
  // Retain consumed requests across Start/Stop so stale lead lists cannot redial them.
  private attempted = new Set<string>();

  constructor(
    private evClient: EvClient,
    private evAuth: EvAuth,
    private evAgentSession: EvAgentSession,
    private evPresence: EvPresence,
    private evWorkingState: EvWorkingState,
    private evCall: EvCall,
    private evLeads: EvLeads,
    private evSettings: EvSettings,
    private evSubscription: EvSubscription,
    private adapter: Adapter,
    private portManager: PortManager,
  ) {
    super();
    const initialize = () => {
      this.evAuth.beforeAgentLogout(async () => {
        await this.stop();
        this.attempted.clear();
      });
      this.evAgentSession.onTriggerConfig(() => this.stop());
      this.evCall.beforeManualDial(() => this.stop());
      this.evSubscription.subscribe(EvCallbackTypes.NEW_CALL, (call) => {
        if (this.pendingRequest && !this.callUii) {
          if (call.callType === 'OUTBOUND' && !call.isMonitoring) {
            this.callUii = call.uii;
            const lead = this.notificationLead;
            this.notificationLead = undefined;
            if (lead) {
              // RingCX selects the destination; the lead may contain several numbers.
              void this.adapter.onCallLead(lead, call.dnisE164 || call.dnis || call.dialDest || '')
                .catch(() => this.logger.warn('progressiveDialer', { event: 'notificationFailed' }));
            }
          }
          else void this.stop();
        }
      });
      this.evSubscription.subscribe(EvCallbackTypes.END_CALL, (call) => {
        if (this.callUii && call.uii === this.callUii) this.finishAttempt();
      });
      this.evSubscription.subscribe(EvCallbackTypes.PREVIEW_LEAD_STATE, (data) => {
        if (data.requestId === this.pendingRequest && TERMINAL_LEAD_STATES.has(data.leadState)) {
          if (!this.callUii && this.evPresence.calls.length === 0) {
            this.evCall.setPhoneIdle();
            this.finishAttempt();
          }
        }
      });
      this.evSubscription.subscribe(EvCallbackTypes.AGENT_STATE, (data) => {
        if (this.running && !['AVAILABLE', 'ENGAGED', 'TRANSITION', 'PREVIEWING'].includes(data.currentState)) {
          void this.stop();
        }
      });
      this.evSubscription.subscribe(EvCallbackTypes.CLOSE_SOCKET, () => this.stop());
      this.evSubscription.subscribe(EvCallbackTypes.OFFHOOK_TERM, () => this.stop());
    };
    if (this.portManager.shared) this.portManager.onServer(initialize);
    else initialize();
  }

  private get group() {
    return this.evAuth.agentConfig?.outboundSettings?.outdialGroup;
  }

  get enabled(): boolean {
    return this.evAuth.agentPermissions?.allowOutbound === true &&
      this.evAuth.agentPermissions?.progressiveEnabled === true &&
      Boolean(this.group?.dialGroupId) && this.group?.dialMode === 'PREVIEW' && !this.group?.hciEnabled;
  }

  get canStart(): boolean {
    return this.enabled && this.sessionReady &&
      this.evWorkingState.agentState?.agentState === 'AVAILABLE' &&
      !this.evWorkingState.isPendingDisposition &&
      this.evPresence.calls.length === 0 && this.evCall.isIdle &&
      !this.evLeads.loading;
  }

  private get sessionReady(): boolean {
    return this.evAuth.isEvLogged && this.evAgentSession.configSuccess &&
      !this.evAgentSession.configuring && this.evClient.appStatus === evStatus.LOGINED;
  }

  @action
  private setState(running: boolean, phase: Phase, seconds = 0, leadId = '') {
    this.running = running;
    this.phase = phase;
    this.secondsUntilNextCall = seconds;
    this.selectedLeadId = leadId;
  }

  @delegate('server')
  async start(): Promise<void> {
    if (this.running || !this.canStart) return;
    const generation = ++this.generation;
    this.groupId = String(this.group.dialGroupId);
    this.connected = this.evPresence.isOffhook;
    this.deadline = Date.now() + 30000;
    this.setState(true, 'connecting');
    this.logger.info('progressiveDialer', { event: 'started' });
    try {
      if (!await this.evCall.prepareProgressiveDial()) throw new Error('Phone unavailable');
      if (!this.isCurrent(generation)) {
        if (this.generation === generation) await this.stop();
        return;
      }
      this.timer = setInterval(() => { void this.tick(); }, 250);
      if (!this.evPresence.isOffhook && !this.evPresence.isOffhooking) {
        await this.evSettings.offHook();
      }
      if (this.isCurrent(generation)) void this.tick();
    } catch {
      if (this.isCurrent(generation)) this.fail();
    }
  }

  @delegate('server')
  async stop(): Promise<void> {
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    this.deadline = 0;
    this.finishAttempt();
    this.setState(false, 'stopped');
    // Stopping prevents future dials; it never hangs up a call already sent.
    this.logger.info('progressiveDialer', { event: 'stopped' });
  }

  private isCurrent(generation: number): boolean {
    return this.running && this.generation === generation && this.enabled && this.sessionReady &&
      String(this.group?.dialGroupId) === this.groupId;
  }

  private finishAttempt() {
    this.pendingRequest = '';
    this.notificationLead = undefined;
    this.callUii = '';
    this.sentAt = 0;
    this.deadline = 0;
  }

  private fail() {
    void this.stop();
    this.setState(false, 'error');
    this.logger.warn('progressiveDialer', { event: 'failed' });
  }

  private nextLead(): Lead | undefined {
    return this.evLeads.leads.find((lead) => !lead.completed && lead.requestId &&
      !this.attempted.has(`${this.groupId}:${lead.requestId}`) &&
      (this.evLeads.leadStatesMapping[lead.requestId] || lead.leadState) === 'PENDING');
  }

  private async tick(): Promise<void> {
    const generation = this.generation;
    if (!this.isCurrent(generation)) { if (this.running) await this.stop(); return; }
    const agentState = this.evWorkingState.agentState?.agentState;
    if (!['AVAILABLE', 'ENGAGED', 'TRANSITION', 'PREVIEWING'].includes(agentState)) {
      await this.stop();
      return;
    }
    if (!this.evPresence.isOffhook) {
      if (this.connected) { await this.stop(); return; }
      if (Date.now() >= this.deadline) this.fail();
      return;
    }
    this.connected = true;
    if (this.pendingRequest) {
      if (!this.callUii && Date.now() - this.sentAt >= 30000) this.fail();
      return;
    }
    if (agentState !== 'AVAILABLE' || this.evPresence.calls.length ||
        this.evWorkingState.isPendingDisposition || !this.evCall.isIdle) {
      this.deadline = 0;
      this.setState(true, 'waiting');
      return;
    }
    if (this.fetching || this.evLeads.loading) return;
    if (this.phase === 'empty' && Date.now() < this.deadline) {
      this.setState(true, 'empty', Math.ceil((this.deadline - Date.now()) / 1000));
      return;
    }
    const lead = this.nextLead();
    if (!lead) { await this.fetch(generation); return; }
    if (this.phase !== 'countdown' || this.selectedLeadId !== lead.leadId) {
      const configuredDelay = Number.parseInt(String(this.group?.progressiveCallDelay), 10);
      const delay = Number.isFinite(configuredDelay) && configuredDelay > 0 ? configuredDelay : 1;
      this.deadline = Date.now() + delay * 1000;
    }
    const seconds = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
    this.setState(true, 'countdown', seconds, lead.leadId);
    if (seconds > 0) return;
    if (!this.evCall.canProgressiveDial) { await this.stop(); return; }
    const requestKey = `${this.groupId}:${lead.requestId}`;
    this.attempted.add(requestKey);
    this.pendingRequest = lead.requestId;
    this.notificationLead = lead;
    this.sentAt = Date.now();
    this.setState(true, 'waiting');
    try {
      // An empty destination lets RingCX choose the campaign's next number, like the full agent.
      const sent = await this.evCall.dialProgressiveLead(lead.requestId);
      if (!sent) {
        this.attempted.delete(requestKey);
        if (this.generation === generation) await this.stop();
        return;
      }
      this.logger.info('progressiveDialer', { event: 'dialRequested' });
    } catch {
      // A failed/ambiguous send is never retried automatically.
      if (this.isCurrent(generation)) this.fail();
    }
  }

  private async fetch(generation: number) {
    this.fetching = true;
    this.evLeads.setLoading(true);
    this.setState(true, 'fetching');
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const response = await Promise.race([
        this.evClient.getPreviewDial(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Lead fetch timed out')), 30000);
        }),
      ]);
      if (!this.isCurrent(generation)) return;
      if (!Array.isArray(response?.leads)) throw new Error('Invalid lead response');
      this.evLeads.setLeads(response.leads);
      await this.adapter.onLoadLeads(response.leads);
      if (!this.isCurrent(generation)) return;
      this.deadline = Date.now() + (this.nextLead() ? 0 : 5000);
      this.setState(true, this.nextLead() ? 'waiting' : 'empty');
    } catch {
      if (this.isCurrent(generation)) this.fail();
    } finally {
      clearTimeout(timeout);
      this.fetching = false;
      this.evLeads.setLoading(false);
    }
    if (this.isCurrent(generation) && this.phase === 'waiting') await this.tick();
  }
}
