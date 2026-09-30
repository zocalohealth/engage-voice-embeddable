jest.mock('@ringcentral-integration/next-core', () => ({
  injectable: () => (target: any) => target,
  computed: () => (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  action: (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  delegate: () => (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  state: () => undefined,
  storage: () => undefined,
  optional: () => () => undefined,
  inject: () => () => undefined,
  watch: jest.fn(),
  RcModule: class { logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; },
  PortManager: class {},
}));

jest.mock('src/app/services/Analytics/track', () => ({
  track: () => (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
}));
jest.mock('src/app/services/EvCall/i18n', () => ({ t: (key: string) => key }));

import { EventEmitter } from 'events';
import { Adapter } from 'src/app/services/Adapter';
import { adapterMessageTypes } from 'src/enums';
import { EvClient } from 'src/app/services/EvClient';
import { EvWidgetDiagnostics } from 'src/app/services/EvWidgetDiagnostics/EvWidgetDiagnostics';
import { EvCallbackTypes } from 'src/app/services/EvClient/enums';
import { WIDGET_BUILD } from 'src/lib/widgetDiagnostics';

function setup() {
  const listeners: Record<string, (data?: any) => void> = {};
  const client = {
    addWidgetDiagnosticListener: jest.fn(),
    getWidgetDiagnosticState: jest.fn().mockResolvedValue({ sdkAgentState: 'AVAILABLE', socketReadyState: 1, sdkOnCall: false, sdkPendingDisposition: false }),
  };
  const adapter = { onDiagnostics: jest.fn().mockResolvedValue(undefined) };
  const service = new EvWidgetDiagnostics(client as any, { subscribe: (type: string, listener: any) => { listeners[type] = listener; } } as any,
    { calls: [], isOffhook: true, isOffhooking: false } as any,
    { agentState: { agentState: 'AVAILABLE' }, isPendingDisposition: false } as any,
    { isIdle: false } as any,
    { phase: 'error', running: false, diagnosticState: { hasPendingLead: true, hasProgressiveCallId: true, startBlockedBy: ['dialing'] } } as any,
    adapter as any, { shared: false } as any);
  return { service, client, adapter, listeners };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

it('projects ACKs into a safe command result without SDK details or call identifiers', async () => {
  const d = setup();
  d.listeners[EvCallbackTypes.ACK]({ type: 'ONE-TO-ONE-OUTDIAL-CANCEL', status: 'FAIL', message: 'patient-sensitive', uii: 'call-sensitive', destination: 'phone-sensitive' });
  await settle();
  expect(d.adapter.onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'command_ack', command: 'manual_cancel', ackStatus: 'FAIL', state: expect.objectContaining({ dialing: true, startBlockedBy: ['dialing'] }) }));
  expect(JSON.stringify(d.adapter.onDiagnostics.mock.calls)).not.toContain('sensitive');
  d.listeners[EvCallbackTypes.ACK]({ type: 'UNKNOWN', status: 'OK' });
  expect(d.adapter.onDiagnostics).toHaveBeenCalledTimes(1);
});

it('captures local state before awaiting SDK diagnostics and sanitizes lead outcomes', async () => {
  const d = setup();
  d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ leadState: 'HANGUP', destination: 'sensitive' });
  await settle();
  expect(d.adapter.onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'lead_state', leadState: 'HANGUP' }));
  d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ leadState: 'sensitive' });
  await settle();
  expect(d.adapter.onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ leadState: 'unknown' }));
});

it('isolates SDK and transport errors from call control', async () => {
  const d = setup();
  d.client.getWidgetDiagnosticState.mockRejectedValue(new Error('sensitive'));
  await expect(d.service.report({ event: 'hangup_clicked' })).resolves.toBeUndefined();
  d.client.getWidgetDiagnosticState.mockResolvedValue({ sdkAgentState: 'AVAILABLE', socketReadyState: 1, sdkOnCall: false, sdkPendingDisposition: false });
  d.adapter.onDiagnostics.mockRejectedValue(new Error('sensitive'));
  await expect(d.service.report({ event: 'hangup_clicked' })).resolves.toBeUndefined();
});

it('stamps the loaded build and a per-widget sequence at the external transport', async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => '11111111-1111-4111-8111-111111111111' } });
  const adapter = Object.assign(Object.create(Adapter.prototype), {
    portManager: { isActiveTab: true }, transport: {}, messageTypes: adapterMessageTypes,
    diagnosticSequence: 0, _postExternalMessage: jest.fn(),
  });
  await adapter.onDiagnostics({ event: 'widget_loaded', at: '2026-09-29T12:00:00.000Z' });
  await adapter.onDiagnostics({ event: 'hangup_clicked', at: '2026-09-29T12:00:01.000Z' });
  const [first, second] = adapter._postExternalMessage.mock.calls.map(([payload]: any[]) => payload.diagnostic);
  expect(first).toMatchObject({ schemaVersion: 1, build: WIDGET_BUILD, sequence: 1 });
  expect(second).toMatchObject({ instanceId: first.instanceId, sequence: 2 });
  adapter.portManager.isActiveTab = false;
  await adapter.onDiagnostics({ event: 'widget_loaded' });
  expect(adapter._postExternalMessage).toHaveBeenCalledTimes(2);
});

it('reports dispatch without pretending the SDK confirmed completion, preserving rejection', async () => {
  const events = new EventEmitter();
  const sdk = { manualOutdialCancel: jest.fn().mockReturnValue(undefined), hangup: jest.fn().mockRejectedValue(new Error('sensitive')) };
  const client = Object.assign(Object.create(EvClient.prototype), { _eventEmitter: events, _sdk: sdk });
  const listener = jest.fn();
  client.addWidgetDiagnosticListener(listener);
  await client.manualOutdialCancel('call-sensitive');
  expect(listener.mock.calls.map(([event]: any[]) => event)).toEqual([
    { event: 'command_requested', command: 'manual_cancel', hasCallIdentifier: true },
    { event: 'command_dispatched', command: 'manual_cancel', hasCallIdentifier: true },
  ]);
  await expect(client.hangup({ sessionId: 'session-sensitive' })).rejects.toThrow('sensitive');
  expect(listener).toHaveBeenLastCalledWith({ event: 'command_failed', command: 'hangup', hasCallIdentifier: true });
  expect(JSON.stringify(listener.mock.calls)).not.toContain('sensitive');
  listener.mockImplementation(() => { throw new Error('logging failure'); });
  await expect(client.manualOutdialCancel('')).resolves.toBeUndefined();
});
