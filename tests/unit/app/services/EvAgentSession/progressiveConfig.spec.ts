jest.mock('@ringcentral-integration/next-core', () => ({
  injectable: () => (target: any) => target,
  optional: () => () => undefined,
  action: (_t: any, _k: string, d: PropertyDescriptor) => d,
  computed: () => (_t: any, _k: string, d: PropertyDescriptor) => d,
  delegate: () => (_t: any, _k: string, d: PropertyDescriptor) => d,
  state: () => undefined,
  storage: () => undefined,
  watch: jest.fn(),
  RcModule: class {},
}));
jest.mock('src/app/services/Analytics/track', () => ({
  track: () => (_t: any, _k: string, d: PropertyDescriptor) => d,
}));
jest.mock('src/app/services/EvAgentSession/i18n', () => ({ t: (key: string) => key }));

import { EvAgentSession } from 'src/app/services/EvAgentSession';

function setup(progressiveEnabled: boolean) {
  const oldConfig = { agentPermissions: { progressiveEnabled: !progressiveEnabled }, outboundSettings: { outdialGroup: { dialGroupId: 'old' } } };
  const nextConfig = { agentPermissions: { progressiveEnabled }, outboundSettings: { outdialGroup: { dialGroupId: 'selected', dialMode: 'PREVIEW' } } };
  const evAuth = { agent: { agentConfig: oldConfig }, setAgent: jest.fn((agent) => { evAuth.agent = agent; }) };
  const evClient = { getAgentConfig: jest.fn().mockResolvedValue(nextConfig) };
  const session = Object.assign(Object.create(EvAgentSession.prototype), {
    evAuth, evClient, configSuccess: false, configuring: false,
    logger: { info: jest.fn(), error: jest.fn() },
    auth: { setNotFreshLogin: jest.fn() },
    _clearCalls: jest.fn(),
    _connectEvServer: jest.fn().mockResolvedValue({ result: { data: { status: 'SUCCESS' } }, existingLoginFound: false }),
    _emitTriggerConfig: jest.fn(),
    _emitConfigSuccess: jest.fn(() => {
      expect(evAuth.agent.agentConfig).toEqual(nextConfig);
    }),
  });
  return { session, evAuth, evClient, nextConfig };
}

describe('session configuration snapshots', () => {
  it.each([true, false])('publishes the selected group with progressive=%s before reporting ready', async (enabled) => {
    const d = setup(enabled);
    await d.session.configureAgent({ config: { dialGroupId: 'selected' } });
    expect(d.evClient.getAgentConfig).toHaveBeenCalledTimes(1);
    expect(d.evAuth.agent.agentConfig).toEqual(d.nextConfig);
    expect(d.session.configSuccess).toBe(true);
    expect(d.session.configuring).toBe(false);
  });

  it('does not report ready when the refreshed SDK configuration is unavailable', async () => {
    const d = setup(true);
    d.evClient.getAgentConfig.mockResolvedValue(null);
    await expect(d.session.configureAgent({ config: { dialGroupId: 'selected' } })).rejects.toThrow();
    expect(d.session._emitConfigSuccess).not.toHaveBeenCalled();
    expect(d.session.configSuccess).toBe(false);
    expect(d.session.configuring).toBe(false);
  });
});
