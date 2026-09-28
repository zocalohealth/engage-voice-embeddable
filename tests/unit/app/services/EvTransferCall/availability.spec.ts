jest.mock('@ringcentral-integration/next-core', () => ({
  injectable: () => (target: any) => target,
  action: (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  delegate: (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  state: () => undefined,
  storage: () => undefined,
  optional: () => () => undefined,
  computed: () => (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  watch: jest.fn(),
  RcModule: class { logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; },
  PortManager: class {},
}));

import { EvTransferCall } from 'src/app/services/EvTransferCall';

const agent = { agentId: 'a', firstName: 'Test', lastName: 'Agent', username: 'test', available: true };
function setup() {
  const client = {
    fetchDirectAgentList: jest.fn().mockResolvedValue({ status: 'OK', agents: [agent] }),
    warmDirectAgentTransfer: jest.fn().mockResolvedValue(undefined),
    coldDirectAgentTransfer: jest.fn().mockResolvedValue(undefined),
  };
  const transfer = new EvTransferCall(client as any, { agentPermissions: {} } as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, { enable: jest.fn() } as any);
  transfer.changeTransferAgentId('a');
  return { client, transfer };
}

describe('transfer recipient availability', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('refreshes availability before starting a consult', async () => {
    const { client, transfer } = setup();
    await transfer.internalTransferCall();
    expect(client.warmDirectAgentTransfer).toHaveBeenCalledWith('a');
    expect(client.coldDirectAgentTransfer).not.toHaveBeenCalled();
    expect(transfer.agentListUpdatedAt).toBe(Date.now());
    expect(transfer.agentListFailed).toBe(false);
  });

  it.each([true, false])('blocks a newly unavailable recipient for stayOnCall=%s', async (warm) => {
    const { client, transfer } = setup();
    transfer.stayOnCall = warm;
    client.fetchDirectAgentList.mockResolvedValue({ status: 'OK', agents: [{ ...agent, available: false }] });
    await expect(transfer.internalTransferCall()).rejects.toThrow('unavailable');
    expect(client.warmDirectAgentTransfer).not.toHaveBeenCalled();
    expect(client.coldDirectAgentTransfer).not.toHaveBeenCalled();
  });

  it('does not transfer using cached availability after a failed refresh', async () => {
    const { client, transfer } = setup();
    await transfer.fetchAgentList();
    client.fetchDirectAgentList.mockRejectedValue(new Error('offline'));
    await expect(transfer.internalTransferCall()).rejects.toThrow('could not be verified');
    expect(transfer.agentListFailed).toBe(true);
    expect(client.warmDirectAgentTransfer).not.toHaveBeenCalled();
  });

  it('rejects failed SDK responses even when they include an old agents array', async () => {
    const { client, transfer } = setup();
    client.fetchDirectAgentList.mockResolvedValue({ status: 'FAILURE', agents: [agent] });
    expect(await transfer.fetchAgentList()).toBe(false);
    expect(transfer.agentListUpdatedAt).toBe(0);
  });

  it('blocks a recipient removed or changed while refreshing', async () => {
    const { client, transfer } = setup();
    client.fetchDirectAgentList.mockResolvedValue({ status: 'OK', agents: [] });
    await expect(transfer.internalTransferCall()).rejects.toThrow('unavailable');
    expect(client.warmDirectAgentTransfer).not.toHaveBeenCalled();
  });

  it('times out once, coalesces polls, and ignores the late response', async () => {
    const { client, transfer } = setup();
    let resolve!: (value: unknown) => void;
    client.fetchDirectAgentList.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const first = transfer.fetchAgentList();
    const second = transfer.fetchAgentList();
    expect(client.fetchDirectAgentList).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(8000);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    resolve({ status: 'OK', agents: [agent] });
    await Promise.resolve();
    expect(transfer.agentListUpdatedAt).toBe(0);
    expect(transfer.agentListFailed).toBe(true);
  });

  it('ignores an in-flight response after the transfer screen is reset', async () => {
    const { client, transfer } = setup();
    let resolve!: (value: unknown) => void;
    client.fetchDirectAgentList.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const request = transfer.fetchAgentList();
    transfer.resetTransferStatus();
    resolve({ status: 'OK', agents: [agent] });
    expect(await request).toBe(false);
    expect(transfer.transferAgentList).toEqual([]);
    expect(transfer.agentListUpdatedAt).toBe(0);
  });
});
