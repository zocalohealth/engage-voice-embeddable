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

import { Adapter } from 'src/app/services/Adapter';
import { adapterMessageTypes } from 'src/enums';
import { EvCall } from 'src/app/services/EvCall';
import { EvClient } from 'src/app/services/EvClient';
import { dialoutStatuses } from 'src/enums';
import { EvWorkingState } from 'src/app/services/EvWorkingState';
import { EvProgressiveDialer } from 'src/app/services/EvProgressiveDialer';
import { EvCallbackTypes, evStatus } from 'src/app/services/EvClient/enums';
import type { Lead } from 'src/app/services/EvLeads';

const lead = (id = '1'): Lead => ({
  leadId: id, requestId: `request-${id}`, externId: id,
  destination: '+15555550100', leadState: 'PENDING',
});

function setup(shared = false) {
  const listeners: Record<string, (data?: any) => void> = {};
  const client = { recordWidgetDiagnostic: jest.fn().mockResolvedValue(undefined), setAgentState: jest.fn().mockResolvedValue(undefined), appStatus: evStatus.CONNECTED, getPreviewDial: jest.fn().mockResolvedValue({ leads: [lead()] }) };
  const auth = { isEvLogged: true, beforeAgentLogout: jest.fn(), agentPermissions: { allowOutbound: true, progressiveEnabled: true }, agentConfig: { outboundSettings: { outdialGroup: { dialGroupId: 'group-1', dialMode: 'PREVIEW', progressiveCallDelay: '3' } } } };
  const session = { configSuccess: true, configuring: false, onTriggerConfig: jest.fn() };
  const presence = { isManualOffhook: false, setIsManualOffhook: jest.fn(async (value) => { presence.isManualOffhook = value; }), isOffhook: true, isOffhooking: false, calls: [] as unknown[] };
  const working = { beforeChangeWorkingState: jest.fn(), isPendingDisposition: false, agentState: { agentState: 'AVAILABLE' } };
  const call = { isIdle: true, canProgressiveDial: true, prepareProgressiveDial: jest.fn().mockResolvedValue(true), dialProgressiveLead: jest.fn().mockResolvedValue(true), beforeManualDial: jest.fn(), setPhoneIdle: jest.fn() };
  const leads = { leads: [] as Lead[], loading: false, leadStatesMapping: {} as Record<string, string>, setLoading: jest.fn((v) => { leads.loading = v; }), setLeads: jest.fn((v) => { leads.leads = v; }) };
  const settings = { offHook: jest.fn().mockResolvedValue(undefined) };
  const subscription = { subscribe: jest.fn((event, cb) => { listeners[event] = cb; }) };
  const messages: unknown[] = [];
  const actualAdapter = Object.assign(Object.create(Adapter.prototype), {
    messageTypes: adapterMessageTypes,
    portManager: { isActiveTab: true },
    transport: { events: { push: 'MessageTransport-push' }, _postMessage: (msg: unknown) => messages.push(msg) },
  });
  const adapter = {
    onLoadLeads: jest.fn(actualAdapter.onLoadLeads.bind(actualAdapter)),
    onCallLead: jest.fn(actualAdapter.onCallLead.bind(actualAdapter)),
  };
  const port = { shared, onServer: jest.fn() };
  const dialer = new EvProgressiveDialer(client as any, auth as any, session as any, presence as any, working as any, call as any, leads as any, settings as any, subscription as any, adapter as any, port as any);
  return { dialer, client, auth, session, presence, working, call, leads, settings, adapter, listeners, port, messages, actualAdapter };
}

function setupRealSubmission() {
  const d = setup();
  const sdk = {
    socket: { readyState: 1 },
    previewDial: jest.fn(),
    _getUIModel: () => ({ getInstance: () => ({
      agentSettings: { isLoggedIn: true, currentState: 'AVAILABLE', isOffhook: true, onCall: false },
      agentPermissions: { progressiveEnabled: true },
      connectionSettings: { isPendingDisp: false },
      outboundSettings: d.auth.agentConfig.outboundSettings,
    }) }),
  };
  const client = Object.assign(Object.create(EvClient.prototype), { _sdk: sdk, appStatus: evStatus.CONNECTED });
  const presence = Object.assign(d.presence, {
    dialoutStatus: dialoutStatuses.idle,
    setCurrentCallUii: jest.fn(),
    setDialoutStatus: jest.fn((status) => { presence.dialoutStatus = status; }),
  });
  const call = Object.assign(Object.create(EvCall.prototype), {
    evClient: client, evAuth: d.auth, evPresence: presence,
    evAgentSession: d.session, evWorkingState: d.working,
    evSettings: { isOffhook: true },
  });
  Object.defineProperty(d.call, 'isIdle', { get: () => call.isIdle });
  d.call.dialProgressiveLead.mockImplementation(call.dialProgressiveLead.bind(call));
  d.call.setPhoneIdle.mockImplementation(call.setPhoneIdle.bind(call));
  return { ...d, sdk };
}

const advance = async (ms = 1000) => { await jest.advanceTimersByTimeAsync(ms); };

describe('progressive dialing', () => {
  it('enables Start after the authenticated agent socket opens', () => {
    const d = setup();
    d.client.appStatus = evStatus.LOGINED;
    expect(d.dialer.canStart).toBe(false);
    d.client.appStatus = evStatus.CONNECTED;
    expect(d.dialer.canStart).toBe(true);
  });
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('keeps an already connected phone open between progressive calls', async () => {
    const d = setup();
    await d.dialer.start();
    expect(d.presence.isManualOffhook).toBe(true);
    expect(d.settings.offHook).not.toHaveBeenCalled();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    d.listeners[EvCallbackTypes.END_CALL]({ uii: 'call-1' });
    expect(d.dialer.running).toBe(true);
    expect(d.presence.isManualOffhook).toBe(true);
  });

  it('fetches a pending lead and dials once after the configured preview delay', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(2999);
    expect(d.client.getPreviewDial).toHaveBeenCalledTimes(1);
    expect(d.call.dialProgressiveLead).not.toHaveBeenCalled();
    await advance(251);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledWith('request-1');
    expect(d.adapter.onCallLead).not.toHaveBeenCalled();
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND', dnisE164: '+15555550100' });
    expect(d.adapter.onCallLead).toHaveBeenCalledWith(lead(), '+15555550100');
    await advance(5000);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
  });

  it('emits the existing parent envelopes with the SDK-selected destination exactly once', async () => {
    const d = setup();
    const multipleNumbers = { ...lead(), destination: '+15555550100|+15555550101', destinationE164: '+15555550100|+15555550101' };
    d.client.getPreviewDial.mockResolvedValue({ leads: [multipleNumbers] });
    await d.dialer.start();
    await advance(3250);
    const call = { uii: 'call-1', callType: 'OUTBOUND', dnisE164: '+15555550101', dnis: '5555550101' };
    d.listeners[EvCallbackTypes.NEW_CALL](call);
    d.listeners[EvCallbackTypes.NEW_CALL](call);
    expect(d.messages).toEqual([
      { type: 'MessageTransport-push', payload: { type: 'rc-ev-loadLeads', leads: [multipleNumbers] } },
      { type: 'MessageTransport-push', payload: { type: 'rc-ev-callLead', lead: multipleNumbers, destination: '+15555550101' } },
    ]);
    await d.actualAdapter.onNewCall(call);
    await d.actualAdapter.onEndCall(call);
    expect(d.messages.slice(2)).toEqual([
      { type: 'MessageTransport-push', payload: { type: 'rc-ev-newCall', call } },
      { type: 'MessageTransport-push', payload: { type: 'rc-ev-endCall', call } },
    ]);
  });

  it('does not emit a progressive lead notification for an inbound interruption', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'inbound', callType: 'INBOUND', ani: '+15555550199' });
    expect(d.adapter.onCallLead).not.toHaveBeenCalled();
    expect(d.dialer.running).toBe(false);
  });

  it('only emits parent messages from the active iframe client', async () => {
    const d = setup();
    d.actualAdapter.portManager.isActiveTab = false;
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND', dnis: '5555550100' });
    expect(d.messages).toEqual([]);
  });

  it.each(['NOANSWER', 'BUSY', 'HANGUP', 'DISCONNECT'])('allows restart after Stop, Away, and pending lead completion: %s', async (leadState) => {
    const d = setup();
    d.call.dialProgressiveLead.mockImplementation(async () => { d.call.isIdle = false; return true; });
    d.call.setPhoneIdle.mockImplementation(() => { d.call.isIdle = true; });
    await d.dialer.start();
    await advance(3250);
    await d.dialer.stop();
    d.working.agentState.agentState = 'AWAY';
    d.listeners[EvCallbackTypes.AGENT_STATE]({ currentState: 'AWAY' });
    d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState });
    d.working.agentState.agentState = 'AVAILABLE';
    d.listeners[EvCallbackTypes.AGENT_STATE]({ currentState: 'AVAILABLE' });
    expect(d.dialer.running).toBe(false);
    expect(d.dialer.canStart).toBe(true);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
  });

  it('does not clear a newer manual dial when the stopped progressive lead finishes', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(3250);
    await d.dialer.stop();
    await d.call.beforeManualDial.mock.calls[0][0]();
    d.call.isIdle = false;
    d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState: 'HANGUP' });
    expect(d.call.setPhoneIdle).not.toHaveBeenCalled();
    expect(d.dialer.canStart).toBe(false);
  });

  it('does not clear an active call or required disposition after stopping', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(3250);
    await d.dialer.stop();
    d.presence.calls = [{}];
    d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState: 'HANGUP' });
    expect(d.call.setPhoneIdle).not.toHaveBeenCalled();
    expect(d.dialer.canStart).toBe(false);
    d.presence.calls = [];
    d.working.isPendingDisposition = true;
    d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState: 'HANGUP' });
    expect(d.dialer.canStart).toBe(false);
    expect(d.working.isPendingDisposition).toBe(true);
  });

  it.each(['running', 'stopped', 'error'])('releases a %s attempt after a terminal result with a call ID but no live session', async (mode) => {
    const d = setupRealSubmission();
    if (mode === 'error') d.sdk.previewDial.mockImplementation(() => { throw new Error('send outcome unknown'); });
    await d.dialer.start();
    await advance(3250);
    if (mode === 'stopped') await d.dialer.stop();
    if (mode === 'error') expect(d.dialer.phase).toBe('error');
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    expect(d.call.isIdle).toBe(false);
    d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState: 'HANGUP' });
    expect(d.presence.calls).toEqual([]);
    expect(d.working.agentState.agentState).toBe('AVAILABLE');
    expect(d.call.isIdle).toBe(true);
    expect(d.dialer.canStart).toBe(true);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
    expect(d.dialer.running).toBe(mode === 'running');
  });

  it.each(['live call', 'disposition', 'TRANSITION', 'ENGAGED'])('retains the dialing lock after a terminal result while blocked by %s', async (blocker) => {
    const d = setupRealSubmission();
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    await d.dialer.stop();
    if (blocker === 'live call') d.presence.calls = [{ uii: 'call-1' }];
    if (blocker === 'disposition') d.working.isPendingDisposition = true;
    if (blocker === 'TRANSITION' || blocker === 'ENGAGED') d.working.agentState.agentState = blocker;
    d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState: 'HANGUP' });
    expect(d.call.isIdle).toBe(false);
    expect(d.dialer.canStart).toBe(false);
    expect(d.call.setPhoneIdle).not.toHaveBeenCalled();
  });

  it('settles a terminal result when Available arrives afterward without restarting the loop', async () => {
    const d = setupRealSubmission();
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    await d.dialer.stop();
    d.working.agentState.agentState = 'TRANSITION';
    d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState: 'HANGUP' });
    expect(d.call.isIdle).toBe(false);
    d.working.agentState.agentState = 'AVAILABLE';
    d.listeners[EvCallbackTypes.AGENT_STATE]({ currentState: 'AVAILABLE' });
    expect(d.call.isIdle).toBe(true);
    expect(d.dialer.canStart).toBe(true);
    await advance(5000);
    expect(d.dialer.running).toBe(false);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
  });

  it.each(['no result', 'unrelated result', 'RINGING'])('keeps an unknown attempt locked after Available with %s', async (result) => {
    const d = setupRealSubmission();
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    await d.dialer.stop();
    if (result === 'unrelated result') d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'other', leadState: 'HANGUP' });
    if (result === 'RINGING') d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState: 'RINGING' });
    d.listeners[EvCallbackTypes.AGENT_STATE]({ currentState: 'AVAILABLE' });
    expect(d.call.isIdle).toBe(false);
    expect(d.dialer.canStart).toBe(false);
  });

  it('does not settle a terminal progressive result after a manual dial takes over', async () => {
    const d = setupRealSubmission();
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    await d.call.beforeManualDial.mock.calls[0][0]();
    d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState: 'HANGUP' });
    d.listeners[EvCallbackTypes.AGENT_STATE]({ currentState: 'AVAILABLE' });
    expect(d.call.isIdle).toBe(false);
    expect(d.call.setPhoneIdle).not.toHaveBeenCalled();
  });

  it('cancels the countdown when stopped', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(1000);
    await d.dialer.stop();
    await advance(10000);
    expect(d.call.dialProgressiveLead).not.toHaveBeenCalled();
  });

  it('discards a fetch that resolves after stop and restart', async () => {
    const d = setup();
    let resolve!: (value: unknown) => void;
    d.client.getPreviewDial.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await d.dialer.start();
    await advance(250);
    await d.dialer.stop();
    await d.dialer.start();
    expect(d.dialer.running).toBe(false);
    resolve({ leads: [lead('stale')] });
    await advance(250);
    expect(d.leads.setLeads).not.toHaveBeenCalled();
    await d.dialer.start();
    await advance(3500);
    expect(d.call.dialProgressiveLead).not.toHaveBeenCalledWith('request-stale');
    expect(d.call.dialProgressiveLead).toHaveBeenCalledWith('request-1');
  });

  it('waits for call completion AND disposition before advancing', async () => {
    const d = setup();
    d.client.getPreviewDial.mockResolvedValue({ leads: [lead(), lead('2')] });
    await d.dialer.start();
    await advance(3250);
    d.presence.calls = [{}];
    d.working.agentState.agentState = 'ENGAGED';
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    await advance(5000);
    d.presence.calls = [];
    d.working.isPendingDisposition = true;
    d.working.agentState.agentState = 'AVAILABLE';
    d.listeners[EvCallbackTypes.END_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    await advance(10000);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
    d.working.isPendingDisposition = false;
    await advance(3500);
    expect(d.call.dialProgressiveLead).toHaveBeenLastCalledWith('request-2');
  });

  it.each(['ON-BREAK', 'WORKING', 'AWAY'])('stops on %s during countdown', async (state) => {
    const d = setup();
    await d.dialer.start();
    await advance(1000);
    d.working.agentState.agentState = state;
    await advance(5000);
    expect(d.dialer.running).toBe(false);
    expect(d.call.dialProgressiveLead).not.toHaveBeenCalled();
  });


  it.each([true, false])('resumes after post-call WORKING (state arrives first: %s)', async (stateFirst) => {
    const d = setup();
    d.client.getPreviewDial.mockResolvedValue({ leads: [lead(), lead('2')] });
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    d.presence.calls = [{}];
    d.call.isIdle = false;
    const working = () => {
      d.working.agentState.agentState = 'WORKING';
      d.listeners[EvCallbackTypes.AGENT_STATE]({ currentState: 'WORKING' });
    };
    if (stateFirst) working();
    d.listeners[EvCallbackTypes.END_CALL]({ uii: 'call-1' });
    if (!stateFirst) working();
    d.working.isPendingDisposition = true;
    await advance(1000);
    expect(d.client.setAgentState).not.toHaveBeenCalled();
    d.presence.calls = [];
    d.call.isIdle = true;
    await advance(1000);
    expect(d.client.setAgentState).not.toHaveBeenCalled();
    d.working.isPendingDisposition = false;
    await advance(1000);
    expect(d.dialer.running).toBe(true);
    expect(d.client.setAgentState).toHaveBeenCalledTimes(1);
    expect(d.client.setAgentState).toHaveBeenCalledWith('AVAILABLE', 'Available');
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
    d.working.agentState.agentState = 'AVAILABLE';
    d.listeners[EvCallbackTypes.AGENT_STATE]({ currentState: 'AVAILABLE' });
    await advance(3500);
    expect(d.call.dialProgressiveLead).toHaveBeenLastCalledWith('request-2');
  });


  it('stops the loop before sending a user-selected status to the SDK', async () => {
    const d = setup();
    await d.dialer.start();
    const working = Object.assign(Object.create(EvWorkingState.prototype), {
      workingStateListeners: [],
      agentState: { agentState: 'AVAILABLE' },
      evPresence: { calls: [] },
      evClient: { setAgentState: jest.fn(async () => {
        expect(d.dialer.running).toBe(false);
      }) },
    });
    working.beforeChangeWorkingState(d.working.beforeChangeWorkingState.mock.calls[0][0]);
    await working.changeWorkingState({ agentState: 'WORKING', agentAuxState: 'Working' });
    expect(working.evClient.setAgentState).toHaveBeenCalledWith('WORKING', 'Working');
  });

  it('honors an explicit status change after a progressive call', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    d.listeners[EvCallbackTypes.END_CALL]({ uii: 'call-1' });
    await d.working.beforeChangeWorkingState.mock.calls[0][0]();
    d.working.agentState.agentState = 'WORKING';
    d.listeners[EvCallbackTypes.AGENT_STATE]({ currentState: 'WORKING' });
    await advance(5000);
    expect(d.dialer.running).toBe(false);
    expect(d.client.setAgentState).not.toHaveBeenCalled();
  });

  it('stops with an error if the server never acknowledges Available', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    d.listeners[EvCallbackTypes.END_CALL]({ uii: 'call-1' });
    d.working.agentState.agentState = 'WORKING';
    d.listeners[EvCallbackTypes.AGENT_STATE]({ currentState: 'WORKING' });
    await advance(11500);
    expect(d.dialer.phase).toBe('error');
    expect(d.client.setAgentState).toHaveBeenCalledTimes(1);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
  });

  it('does not resume after an unrelated inbound call interrupts the loop', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    d.listeners[EvCallbackTypes.END_CALL]({ uii: 'call-1' });
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'inbound', callType: 'INBOUND' });
    d.working.agentState.agentState = 'WORKING';
    await advance(5000);
    expect(d.dialer.running).toBe(false);
    expect(d.client.setAgentState).not.toHaveBeenCalled();
  });

  it('reports no leads after a completed call and continues polling', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    d.client.getPreviewDial.mockResolvedValue({ leads: [] });
    d.listeners[EvCallbackTypes.END_CALL]({ uii: 'call-1' });
    await advance(250);
    expect(d.dialer.running).toBe(true);
    expect(d.dialer.phase).toBe('empty');
    expect(d.dialer.secondsUntilNextCall).toBe(5);
    const fetched = d.client.getPreviewDial.mock.calls.length;
    await advance(5000);
    expect(d.client.getPreviewDial).toHaveBeenCalledTimes(fetched + 1);
  });

  it('immediately reports a five-second retry when no leads are returned', async () => {
    const d = setup();
    d.client.getPreviewDial.mockResolvedValue({ leads: [] });
    await d.dialer.start();
    await advance(0);
    expect(d.dialer.running).toBe(true);
    expect(d.dialer.phase).toBe('empty');
    expect(d.dialer.secondsUntilNextCall).toBe(5);
  });

  it('polls an empty queue every five seconds without overlapping fetches', async () => {
    const d = setup();
    d.client.getPreviewDial.mockResolvedValue({ leads: [] });
    await d.dialer.start();
    await advance(4999);
    expect(d.client.getPreviewDial).toHaveBeenCalledTimes(1);
    await advance(501);
    expect(d.client.getPreviewDial).toHaveBeenCalledTimes(2);
  });

  it.each(['permission', 'socket', 'group', 'phone'])('stops when %s changes', async (change) => {
    const d = setup();
    await d.dialer.start();
    await advance(1000);
    if (change === 'permission') d.auth.agentPermissions.progressiveEnabled = false;
    if (change === 'socket') d.client.appStatus = evStatus.RECONNECTING;
    if (change === 'group') d.auth.agentConfig.outboundSettings.outdialGroup.dialGroupId = 'group-2';
    if (change === 'phone') d.presence.isOffhook = false;
    await advance(5000);
    expect(d.dialer.running).toBe(false);
    expect(d.call.dialProgressiveLead).not.toHaveBeenCalled();
  });

  it('stops on fetch failure instead of retrying an ambiguous operation', async () => {
    const d = setup();
    d.client.getPreviewDial.mockRejectedValue(new Error('offline'));
    await d.dialer.start();
    await advance();
    expect(d.dialer.running).toBe(false);
    expect(d.dialer.phase).toBe('error');
  });

  it('uses a one-second fallback when the group has no valid delay', async () => {
    const d = setup();
    d.auth.agentConfig.outboundSettings.outdialGroup.progressiveCallDelay = '0';
    await d.dialer.start();
    await advance(999);
    expect(d.call.dialProgressiveLead).not.toHaveBeenCalled();
    await advance(251);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
  });

  it('times out a stuck fetch and ignores its eventual response', async () => {
    const d = setup();
    let resolve!: (value: unknown) => void;
    d.client.getPreviewDial.mockReturnValue(new Promise((r) => { resolve = r; }));
    await d.dialer.start();
    await advance(30250);
    expect(d.dialer.phase).toBe('error');
    resolve({ leads: [lead()] });
    await advance(5000);
    expect(d.leads.setLeads).not.toHaveBeenCalled();
    expect(d.call.dialProgressiveLead).not.toHaveBeenCalled();
  });

  it('stops on an unacknowledged dial without automatically dialing another lead', async () => {
    const d = setup();
    d.client.getPreviewDial.mockResolvedValue({ leads: [lead(), lead('2')] });
    await d.dialer.start();
    await advance(35000);
    expect(d.dialer.phase).toBe('error');
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated call-end notifications', async () => {
    const d = setup();
    d.client.getPreviewDial.mockResolvedValue({ leads: [lead(), lead('2')] });
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.NEW_CALL]({ uii: 'call-1', callType: 'OUTBOUND' });
    d.listeners[EvCallbackTypes.END_CALL]({ uii: 'another-call' });
    await advance(5000);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
  });

  it('advances after a matching failed lead attempt without redialing the request', async () => {
    const d = setup();
    d.client.getPreviewDial.mockResolvedValue({ leads: [lead(), lead('2')] });
    await d.dialer.start();
    await advance(3250);
    d.listeners[EvCallbackTypes.PREVIEW_LEAD_STATE]({ requestId: 'request-1', leadState: 'BUSY' });
    await advance(3500);
    expect(d.call.dialProgressiveLead).toHaveBeenLastCalledWith('request-2');
    expect(d.call.setPhoneIdle).toHaveBeenCalledTimes(1);
  });

  it('does not dial while offhook initialization is pending', async () => {
    const d = setup();
    d.presence.isOffhook = false;
    await d.dialer.start();
    await advance(5000);
    expect(d.settings.offHook).toHaveBeenCalledTimes(1);
    expect(d.client.getPreviewDial).not.toHaveBeenCalled();
    d.presence.isOffhook = true;
    await advance(3500);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
  });

  it('does not connect or dial after stopping during microphone setup', async () => {
    const d = setup();
    let resolve!: (value: boolean) => void;
    d.call.prepareProgressiveDial.mockReturnValue(new Promise((r) => { resolve = r; }));
    const start = d.dialer.start();
    await d.dialer.stop();
    resolve(true);
    await start;
    await advance(5000);
    expect(d.settings.offHook).not.toHaveBeenCalled();
    expect(d.client.getPreviewDial).not.toHaveBeenCalled();
  });

  it('stops when a manual call begins through any call entry point', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(1000);
    await d.call.beforeManualDial.mock.calls[0][0]();
    await advance(5000);
    expect(d.call.dialProgressiveLead).not.toHaveBeenCalled();
    expect(d.dialer.running).toBe(false);
  });

  it('retains an unsent lead for an explicit retry when readiness changes at submission', async () => {
    const d = setup();
    d.call.dialProgressiveLead.mockResolvedValueOnce(false);
    await d.dialer.start();
    await advance(3250);
    expect(d.dialer.running).toBe(false);
    expect(d.adapter.onCallLead).not.toHaveBeenCalled();
    await d.dialer.start();
    await advance(3250);
    expect(d.call.dialProgressiveLead).toHaveBeenNthCalledWith(2, 'request-1');
  });

  it('runs lifecycle listeners only on the shared server', () => {
    const d = setup(true);
    expect(d.auth.beforeAgentLogout).not.toHaveBeenCalled();
    expect(d.port.onServer).toHaveBeenCalledTimes(1);
    d.port.onServer.mock.calls[0][0]();
    expect(d.auth.beforeAgentLogout).toHaveBeenCalledTimes(1);
    expect(d.session.onTriggerConfig).toHaveBeenCalledTimes(1);
  });

  it('requires the progressive permission and an available agent', async () => {
    const d = setup();
    d.auth.agentPermissions.progressiveEnabled = false;
    await d.dialer.start();
    await advance();
    expect(d.client.getPreviewDial).not.toHaveBeenCalled();
    d.auth.agentPermissions.progressiveEnabled = true;
    d.working.agentState.agentState = 'WORKING';
    await d.dialer.start();
    await advance();
    expect(d.client.getPreviewDial).not.toHaveBeenCalled();
  });
});
