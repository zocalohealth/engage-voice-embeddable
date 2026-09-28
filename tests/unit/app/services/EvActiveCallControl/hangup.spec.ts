jest.mock('@ringcentral-integration/next-core', () => ({
  injectable: () => (target: any) => target,
  action: (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  delegate: () => (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  state: () => undefined,
  storage: () => undefined,
  optional: () => () => undefined,
  RcModule: class { logger = { info: jest.fn(), warn: jest.fn() }; },
}));

import { EvActiveCallControl } from 'src/app/services/EvActiveCallControl';
import { EventEmitter } from 'events';
import { EvCallbackTypes, evStatus } from 'src/app/services/EvClient/enums';

function setup() {
  const presence = { calls: [{ uii: 'call-1', session: { sessionId: '1' } }], otherCalls: [{ uii: 'call-1', session: { sessionId: '2' } }], isOffhook: true };
  const client = { appStatus: evStatus.CONNECTED, hangup: jest.fn(), hold: jest.fn(), manualOutdialCancel: jest.fn(), offhookTerm: jest.fn() };
  const toast = { danger: jest.fn() };
  const events = new EventEmitter();
  const subscription = { subscribe: events.on.bind(events), off: events.off.bind(events) };
  const control = new EvActiveCallControl(client as any, presence as any,
    subscription as any, {} as any, {} as any, { enable: jest.fn() } as any, toast as any);
  return { control, presence, client, toast, events };
}

describe('hangup confirmation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('does not report completion or unhold a customer before the consult leg ends', async () => {
    const d = setup();
    d.control.setUnholdOnHangup(true);
    const done = jest.fn();
    const result = d.control.hangUp('1').then(done);
    await jest.advanceTimersByTimeAsync(250);
    expect(done).not.toHaveBeenCalled();
    expect(d.client.hold).not.toHaveBeenCalled();
    d.presence.calls = [];
    await jest.advanceTimersByTimeAsync(250);
    await result;
    expect(done).toHaveBeenCalledTimes(1);
    expect(d.toast.danger).not.toHaveBeenCalled();
    expect(d.client.hold).toHaveBeenCalledWith(false);
  });
  it.each(['rejected', 'timeout', 'offline', 'disconnected'])('shows a retryable failure for %s instead of claiming the call ended', async (failure) => {
    const d = setup();
    d.control.setUnholdOnHangup(true);
    if (failure === 'rejected') d.client.hangup.mockRejectedValue(new Error('send failed'));
    if (failure === 'offline') d.client.appStatus = evStatus.RECONNECTING;
    const result = d.control.hangUp('1');
    await jest.advanceTimersByTimeAsync(250);
    if (failure === 'disconnected') d.client.appStatus = evStatus.RECONNECTING;
    await jest.advanceTimersByTimeAsync(10000);
    await result;
    expect(d.toast.danger).toHaveBeenCalledTimes(1);
    expect(d.client.hold).not.toHaveBeenCalled();
    expect(d.presence.calls).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
    d.client.appStatus = evStatus.CONNECTED;
    d.client.hangup.mockImplementation(() => { d.presence.calls = []; });
    await d.control.hangUp('1');
    expect(d.client.hold).toHaveBeenCalledWith(false);
  });

  it('deduplicates repeated clicks and unholds only once', async () => {
    const d = setup();
    d.control.setUnholdOnHangup(true);
    const first = d.control.hangUp('1');
    const second = d.control.hangUp('1');
    await jest.advanceTimersByTimeAsync(250);
    expect(d.client.hangup).toHaveBeenCalledTimes(1);
    d.presence.calls = [];
    await jest.advanceTimersByTimeAsync(250);
    await Promise.all([first, second]);
    expect(d.client.hold).toHaveBeenCalledTimes(1);
  });

  it('never retries a hangup automatically against a new call reusing the session id', async () => {
    const d = setup();
    const result = d.control.hangupSession({ sessionId: '1' });
    await jest.advanceTimersByTimeAsync(250);
    d.presence.calls = [{ uii: 'call-2', session: { sessionId: '1' } }];
    await jest.advanceTimersByTimeAsync(250);
    expect(await result).toBe(true);
    expect(d.client.hangup).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown session without sending a hangup', async () => {
    const d = setup();
    expect(await d.control.hangupSession({ sessionId: 'missing' })).toBe(false);
    expect(d.client.hangup).not.toHaveBeenCalled();
    expect(d.toast.danger).toHaveBeenCalledTimes(1);
  });
  it('still closes pending offhook when manual cancellation rejects', async () => {
    const d = setup();
    d.presence.calls = [];
    d.presence.otherCalls = [];
    d.client.manualOutdialCancel.mockRejectedValue(new Error('not manual'));
    d.client.offhookTerm.mockImplementation(() => { d.presence.isOffhook = false; });
    await d.control.hangUpDialer();
    expect(d.client.offhookTerm).toHaveBeenCalledTimes(1);
    expect(d.toast.danger).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'rejected'])('reports an unconfirmed pending hangup: %s', async (failure) => {
    const d = setup();
    d.presence.calls = [];
    d.presence.otherCalls = [];
    if (failure === 'rejected') d.client.offhookTerm.mockRejectedValue(new Error('send failed'));
    const result = d.control.hangUpDialer();
    await jest.advanceTimersByTimeAsync(10000);
    await result;
    expect(d.toast.danger).toHaveBeenCalledTimes(1);
    expect(d.presence.isOffhook).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not send a late hangup after a pending cancellation times out', async () => {
    const d = setup();
    d.presence.calls = [];
    let complete: () => void;
    d.client.manualOutdialCancel.mockReturnValue(new Promise<void>((resolve) => { complete = resolve; }));
    const result = d.control.hangUpDialer();
    await jest.advanceTimersByTimeAsync(10000);
    await result;
    d.presence.calls = [{ uii: 'new-call', session: { sessionId: '1' } }];
    complete!();
    await jest.advanceTimersByTimeAsync(250);
    expect(d.client.hangup).not.toHaveBeenCalled();
    expect(d.client.offhookTerm).not.toHaveBeenCalled();
    expect(d.toast.danger).toHaveBeenCalledTimes(1);
  });

  it('reports failure to resume a held customer without losing the recovery flag', async () => {
    const d = setup();
    d.control.setUnholdOnHangup(true);
    d.client.hangup.mockImplementation(() => { d.presence.calls = []; });
    d.client.hold.mockRejectedValue(new Error('resume failed'));
    await d.control.hangUp('1');
    expect(d.control.unholdOnHangup).toBe(true);
    expect(d.toast.danger).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('still on hold') }));
  });
  it('waits for explicit offhook confirmation when the phone was not connected yet', async () => {
    const d = setup();
    d.presence.calls = [];
    d.presence.otherCalls = [];
    d.presence.isOffhook = false;
    const done = jest.fn();
    const result = d.control.hangUpDialer().then(done);
    await jest.advanceTimersByTimeAsync(250);
    expect(done).not.toHaveBeenCalled();
    d.events.emit(EvCallbackTypes.OFFHOOK_TERM);
    await jest.advanceTimersByTimeAsync(250);
    await result;
    expect(d.toast.danger).not.toHaveBeenCalled();
    expect(d.events.listenerCount(EvCallbackTypes.OFFHOOK_TERM)).toBe(0);
  });
});
