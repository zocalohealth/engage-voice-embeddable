jest.mock('@ringcentral-integration/next-core', () => ({
  injectable: () => (target: any) => target,
  action: (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  delegate: () => (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  state: () => undefined,
  watch: jest.fn(),
  RcModule: class { logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; },
  PortManager: class {},
}));

import { EvProgressiveDialer } from 'src/app/services/EvProgressiveDialer';
import { EvCallbackTypes, evStatus } from 'src/app/services/EvClient/enums';
import type { Lead } from 'src/app/services/EvLeads';

const lead = (id = '1'): Lead => ({
  leadId: id, requestId: `request-${id}`, externId: id,
  destination: '+15555550100', leadState: 'PENDING',
});

function setup(shared = false) {
  const listeners: Record<string, (data?: any) => void> = {};
  const client = { appStatus: evStatus.LOGINED, getPreviewDial: jest.fn().mockResolvedValue({ leads: [lead()] }) };
  const auth = { isEvLogged: true, beforeAgentLogout: jest.fn(), agentPermissions: { allowOutbound: true, progressiveEnabled: true }, agentConfig: { outboundSettings: { outdialGroup: { dialGroupId: 'group-1', dialMode: 'PREVIEW', progressiveCallDelay: '3' } } } };
  const session = { configSuccess: true, configuring: false, onTriggerConfig: jest.fn() };
  const presence = { isOffhook: true, isOffhooking: false, calls: [] as unknown[] };
  const working = { isPendingDisposition: false, agentState: { agentState: 'AVAILABLE' } };
  const call = { isIdle: true, canProgressiveDial: true, prepareProgressiveDial: jest.fn().mockResolvedValue(true), dialProgressiveLead: jest.fn().mockResolvedValue(true), beforeManualDial: jest.fn(), setPhoneIdle: jest.fn() };
  const leads = { leads: [] as Lead[], loading: false, leadStatesMapping: {} as Record<string, string>, setLoading: jest.fn((v) => { leads.loading = v; }), setLeads: jest.fn((v) => { leads.leads = v; }) };
  const settings = { offHook: jest.fn().mockResolvedValue(undefined) };
  const subscription = { subscribe: jest.fn((event, cb) => { listeners[event] = cb; }) };
  const adapter = { onLoadLeads: jest.fn().mockResolvedValue(undefined), onCallLead: jest.fn().mockResolvedValue(undefined) };
  const port = { shared, onServer: jest.fn() };
  const dialer = new EvProgressiveDialer(client as any, auth as any, session as any, presence as any, working as any, call as any, leads as any, settings as any, subscription as any, adapter as any, port as any);
  return { dialer, client, auth, session, presence, working, call, leads, settings, adapter, listeners, port };
}

const advance = async (ms = 1000) => { await jest.advanceTimersByTimeAsync(ms); };

describe('progressive dialing', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('fetches a pending lead and dials once after the configured preview delay', async () => {
    const d = setup();
    await d.dialer.start();
    await advance(2999);
    expect(d.client.getPreviewDial).toHaveBeenCalledTimes(1);
    expect(d.call.dialProgressiveLead).not.toHaveBeenCalled();
    await advance(251);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledWith('request-1');
    expect(d.adapter.onCallLead).toHaveBeenCalledWith(lead(), '+15555550100');
    await advance(5000);
    expect(d.call.dialProgressiveLead).toHaveBeenCalledTimes(1);
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
