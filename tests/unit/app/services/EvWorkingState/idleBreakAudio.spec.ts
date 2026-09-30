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
import { watch } from '@ringcentral-integration/next-core';
import { EvWorkingState } from 'src/app/services/EvWorkingState';
import { EvProgressiveDialer } from 'src/app/services/EvProgressiveDialer';
import { EvClient } from 'src/app/services/EvClient';
import { EvCallbackTypes, evStatus } from 'src/app/services/EvClient/enums';
import { dialoutStatuses } from 'src/enums';

function setup() {
  const callbacks: Record<string, Array<(data?: any) => unknown>> = {};
  const subscription = { subscribe: (event: string, callback: (data?: any) => unknown) => { (callbacks[event] ||= []).push(callback); return subscription; } };
  const notify = async (event: string, data?: any) => { for (const callback of callbacks[event] || []) await callback(data); };
  const presence = {
    isOffhook: true, isOffhooking: false, isManualOffhook: false, calls: [] as unknown[], dialoutStatus: dialoutStatuses.idle,
    setIsManualOffhook: jest.fn(async (value: boolean) => { presence.isManualOffhook = value; }),
  };
  const agentSettings = { currentState: 'AVAILABLE', onCall: false, isOffhook: true, callState: null as string | null };
  const connectionSettings = { isPendingDisp: false };
  const sdk = {
    socket: { readyState: 1 }, offhookTerm: jest.fn(),
    _getUIModel: () => ({ getInstance: () => ({ agentSettings, connectionSettings }) }),
    setAgentState: jest.fn(async (currentState: string, currentAuxState: string) => {
      agentSettings.currentState = currentState;
      await notify(EvCallbackTypes.AGENT_STATE, { currentState, currentAuxState, status: 'OK' });
    }),
  };
  const client = Object.assign(Object.create(EvClient.prototype), { _sdk: sdk, _eventEmitter: new EventEmitter(), appStatus: evStatus.CONNECTED });
  const auth = { isEvLogged: true, beforeAgentLogout: jest.fn(), agentPermissions: { allowOutbound: true, progressiveEnabled: true }, agentConfig: { outboundSettings: { outdialGroup: { dialGroupId: 'group-1', dialMode: 'PREVIEW', progressiveCallDelay: '3' } } } };
  const session = { configSuccess: true, configuring: false, onTriggerConfig: jest.fn() };
  const toast = { warning: jest.fn() };
  const working = new EvWorkingState(client as any, auth as any, subscription as any, { onCallEnded: jest.fn() } as any, presence as any, session as any, { isDisposed: () => true } as any, toast as any, { enable: jest.fn() } as any, { shared: false } as any);
  const call = { isIdle: true, prepareProgressiveDial: jest.fn().mockResolvedValue(true), beforeManualDial: jest.fn() };
  client.getPreviewDial = jest.fn().mockResolvedValue({ leads: [] });
  const dialer = new EvProgressiveDialer(client as any, auth as any, session as any, presence as any, working as any, call as any, { loading: false, leads: [], setLoading: jest.fn(), setLeads: jest.fn() } as any, { offHook: jest.fn() } as any, subscription as any, { onLoadLeads: jest.fn().mockResolvedValue(undefined) } as any, { shared: false } as any);
  const runWatch = async () => {
    const watches = (watch as jest.Mock).mock.calls.filter(([owner]) => owner === working);
    for (const [, selector, callback] of watches) await callback(selector());
  };
  return { working, dialer, sdk, client, presence, agentSettings, connectionSettings, notify, toast, runWatch };
}

beforeEach(() => { jest.useFakeTimers(); (watch as jest.Mock).mockClear(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

it('disconnects an idle audio leg after progressive dialing pauses for a confirmed break', async () => {
  const d = setup();
  await d.dialer.start();
  expect(d.presence.isManualOffhook).toBe(true);
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.dialer.running).toBe(false);
  expect(d.working.agentState.agentState).toBe('ON-BREAK');
  expect(d.sdk.offhookTerm).toHaveBeenCalledTimes(1);
});

it.each(['AVAILABLE', 'WORKING', 'ENGAGED', 'TRANSITION', 'BREAK-AFTER-CALL'])('keeps audio connected in %s', async (state) => {
  const d = setup();
  d.agentSettings.currentState = state;
  await d.notify(EvCallbackTypes.AGENT_STATE, { currentState: state, currentAuxState: state, status: 'OK' });
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
});

it('waits for a live call to end before closing the break audio connection', async () => {
  const d = setup();
  d.presence.calls = [{}];
  d.agentSettings.onCall = true;
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
  d.presence.calls = [];
  d.agentSettings.onCall = false;
  await d.runWatch();
  expect(d.sdk.offhookTerm).toHaveBeenCalledTimes(1);
});

it('does not tear down a pending dial or change it to idle', async () => {
  const d = setup();
  d.presence.dialoutStatus = dialoutStatuses.dialing;
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
  expect(d.presence.dialoutStatus).toBe(dialoutStatuses.dialing);
});

it('waits until disposition and an offhook connection in progress settle', async () => {
  const d = setup();
  d.working.isPendingDisposition = true;
  d.presence.isOffhooking = true;
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
  d.working.isPendingDisposition = false;
  d.presence.isOffhooking = false;
  await d.runWatch();
  expect(d.sdk.offhookTerm).toHaveBeenCalledTimes(1);
});

it('rechecks the SDK at dispatch when a call arrives before the main-client delegation runs', async () => {
  const d = setup();
  const disconnect = d.client.disconnectIdleBreakAudio?.bind(d.client);
  d.client.disconnectIdleBreakAudio = jest.fn(async () => {
    d.agentSettings.onCall = true;
    return disconnect?.() || false;
  });
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
});

it.each(['onCall', 'isPendingDisp', 'socket', 'unconfirmed', 'unknown'])('refuses teardown when SDK safety check is %s', async (blocker) => {
  const d = setup();
  d.agentSettings.currentState = 'ON-BREAK';
  d.working.setAgentState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  if (blocker === 'onCall') d.agentSettings.onCall = true;
  if (blocker === 'isPendingDisp') d.connectionSettings.isPendingDisp = true;
  if (blocker === 'socket') d.sdk.socket.readyState = 3;
  if (blocker === 'unconfirmed') d.agentSettings.currentState = 'AVAILABLE';
  if (blocker === 'unknown') Reflect.deleteProperty(d.agentSettings, 'onCall');
  await d.runWatch();
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
});

it('dispatches once and keeps audio marked connected until the real terminal callback', async () => {
  const d = setup();
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  await d.runWatch();
  await d.notify(EvCallbackTypes.AGENT_STATE, { currentState: 'ON-BREAK', currentAuxState: 'Break', status: 'OK' });
  expect(d.sdk.offhookTerm).toHaveBeenCalledTimes(1);
  expect(d.presence.isOffhook).toBe(true);
});

it('isolates send failure and allows a later explicit state update to try again', async () => {
  const d = setup();
  d.sdk.offhookTerm.mockImplementationOnce(() => { throw new Error('send failed'); });
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.presence.isOffhook).toBe(true);
  await d.notify(EvCallbackTypes.AGENT_STATE, { currentState: 'ON-BREAK', currentAuxState: 'Break', status: 'OK' });
  expect(d.sdk.offhookTerm).toHaveBeenCalledTimes(2);
});

it('does not close audio on a Break request until the server confirms it', async () => {
  const d = setup();
  d.sdk.setAgentState.mockResolvedValue(undefined);
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  await d.runWatch();
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
  d.agentSettings.currentState = 'ON-BREAK';
  await d.notify(EvCallbackTypes.AGENT_STATE, { currentState: 'ON-BREAK', currentAuxState: 'Break', status: 'OK' });
  expect(d.sdk.offhookTerm).toHaveBeenCalledTimes(1);
});

it('does not treat a failed Break response as permission to disconnect', async () => {
  const d = setup();
  await d.notify(EvCallbackTypes.AGENT_STATE, { currentState: 'ON-BREAK', currentAuxState: 'Break', status: 'FAIL' });
  expect(d.agentSettings.currentState).toBe('AVAILABLE');
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
});

it('honors Break after call only when the SDK reports the final break state', async () => {
  const d = setup();
  d.sdk.setAgentState.mockImplementationOnce(async () => {
    d.agentSettings.currentState = 'BREAK-AFTER-CALL';
    await d.notify(EvCallbackTypes.AGENT_STATE, { currentState: 'BREAK-AFTER-CALL', currentAuxState: '', status: 'OK' });
  });
  d.presence.calls = [{}];
  d.agentSettings.onCall = true;
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.working.agentState.agentState).toBe('BREAK-AFTER-CALL');
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
  d.presence.calls = [];
  d.agentSettings.onCall = false;
  await d.runWatch();
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
  d.agentSettings.currentState = 'ON-BREAK';
  await d.notify(EvCallbackTypes.AGENT_STATE, { currentState: 'ON-BREAK', currentAuxState: 'Break', status: 'OK' });
  expect(d.sdk.offhookTerm).toHaveBeenCalledTimes(1);
});

it('accepts explicit string booleans from the SDK, preserving unknown as unsafe', async () => {
  const d = setup();
  Reflect.set(d.agentSettings, 'onCall', 'false');
  Reflect.set(d.agentSettings, 'isOffhook', 'true');
  Reflect.set(d.connectionSettings, 'isPendingDisp', 'false');
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.sdk.offhookTerm).toHaveBeenCalledTimes(1);
});

it.each(['ACTIVE', 'ACTIVE-MONITORING', 'unexpected', undefined])('does not close a call allocated before live sessions arrive (%s)', async (callState) => {
  const d = setup();
  Reflect.set(d.agentSettings, 'callState', callState);
  expect(d.agentSettings.onCall).toBe(false);
  expect(d.presence.calls).toHaveLength(0);
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.sdk.offhookTerm).not.toHaveBeenCalled();
});

it('closes the idle agent leg left over from a completed call', async () => {
  const d = setup();
  d.agentSettings.callState = 'CALL-ENDED';
  await d.working.changeWorkingState({ agentState: 'ON-BREAK', agentAuxState: 'Break' });
  expect(d.sdk.offhookTerm).toHaveBeenCalledTimes(1);
});
