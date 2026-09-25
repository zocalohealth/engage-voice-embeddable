jest.mock('@ringcentral-integration/next-core', () => ({
  injectable: () => (target: any) => target,
  optional: () => () => undefined,
  inject: () => () => undefined,
  action: (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  computed: () => (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  delegate: () => (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
  state: () => undefined,
  storage: () => undefined,
  RcModule: class {},
  PortManager: class {},
  StoragePlugin: class {},
}));
jest.mock('src/app/services/Analytics/track', () => ({
  track: () => (_t: any, _k: string, descriptor: PropertyDescriptor) => descriptor,
}));
jest.mock('src/app/services/EvCall/i18n', () => ({ t: (key: string) => key }));

import { EvCall } from 'src/app/services/EvCall';
import { EvClient } from 'src/app/services/EvClient';
import { dialoutStatuses } from 'src/enums';
import { evStatus } from 'src/app/services/EvClient/enums';

function setup() {
  const model = {
    agentSettings: { isLoggedIn: true, currentState: 'AVAILABLE', isOffhook: true, onCall: false },
    agentPermissions: { progressiveEnabled: true },
    connectionSettings: { isPendingDisp: false },
    outboundSettings: { outdialGroup: { dialGroupId: 'group-1' } },
  };
  const sdk = { previewDial: jest.fn(), socket: { readyState: 1 }, _getUIModel: () => ({ getInstance: () => model }) };
  const client = Object.assign(Object.create(EvClient.prototype), { _sdk: sdk, appStatus: evStatus.LOGINED });
  const presence = {
    calls: [] as unknown[], dialoutStatus: dialoutStatuses.idle,
    setCurrentCallUii: jest.fn(),
    setDialoutStatus: jest.fn((status) => { presence.dialoutStatus = status; }),
  };
  const deps = {
    evClient: client,
    evAuth: { agentConfig: { outboundSettings: { outdialGroup: { dialGroupId: 'group-1' } } }, isEvLogged: true, agentPermissions: { allowOutbound: true, progressiveEnabled: true } },
    evAgentSession: { configSuccess: true, configuring: false, isIntegratedSoftphone: true },
    evWorkingState: { agentState: { agentState: 'AVAILABLE' }, isPendingDisposition: false },
    evPresence: presence,
    evSettings: { isOffhook: true },
    evIntegratedSoftphone: { sipRegisterSuccess: true, askAudioPermission: jest.fn().mockResolvedValue(true) },
  };
  const call: EvCall = Object.assign(Object.create(EvCall.prototype), deps);
  return { call, sdk, model, ...deps };
}

describe('progressive call submission to the Agent SDK', () => {
  it('sends only the request ID and marks dialing before the SDK call', async () => {
    const d = setup();
    d.sdk.previewDial.mockImplementation(() => {
      expect(d.evPresence.dialoutStatus).toBe(dialoutStatuses.dialing);
    });
    await d.call.dialProgressiveLead('request-1');
    expect(d.sdk.previewDial).toHaveBeenCalledWith('request-1', '', '');
    await expect(d.call.dialProgressiveLead('request-2')).resolves.toBe(false);
    expect(d.sdk.previewDial).toHaveBeenCalledTimes(1);
  });

  it.each(['disposition', 'call', 'unavailable', 'offhook', 'sip', 'socket', 'permission', 'configuration'])('rejects a %s change at submission time', async (condition) => {
    const d = setup();
    if (condition === 'disposition') d.evWorkingState.isPendingDisposition = true;
    if (condition === 'call') d.evPresence.calls = [{}];
    if (condition === 'unavailable') d.evWorkingState.agentState.agentState = 'ON-BREAK';
    if (condition === 'offhook') d.evSettings.isOffhook = false;
    if (condition === 'sip') d.evIntegratedSoftphone.sipRegisterSuccess = false;
    if (condition === 'socket') d.evClient.appStatus = evStatus.CLOSED;
    if (condition === 'permission') d.evAuth.agentPermissions.progressiveEnabled = false;
    if (condition === 'configuration') d.evAgentSession.configuring = true;
    await expect(d.call.dialProgressiveLead('request-1')).resolves.toBe(false);
    expect(d.sdk.previewDial).not.toHaveBeenCalled();
  });

  it('propagates an uncertain SDK send failure without resetting the dialing lock', async () => {
    const d = setup();
    d.sdk.previewDial.mockImplementation(() => { throw new Error('connection lost'); });
    await expect(d.call.dialProgressiveLead('request-1')).rejects.toThrow('connection lost');
    expect(d.evPresence.dialoutStatus).toBe(dialoutStatuses.dialing);
  });

  it.each(['socket', 'group', 'state', 'disposition', 'call', 'offhook', 'permission'])('rechecks SDK %s after the shared-worker relay', async (condition) => {
    const d = setup();
    if (condition === 'socket') d.sdk.socket.readyState = 3;
    if (condition === 'group') d.model.outboundSettings.outdialGroup.dialGroupId = 'other-group';
    if (condition === 'state') d.model.agentSettings.currentState = 'ON-BREAK';
    if (condition === 'disposition') d.model.connectionSettings.isPendingDisp = true;
    if (condition === 'call') d.model.agentSettings.onCall = true;
    if (condition === 'offhook') d.model.agentSettings.isOffhook = false;
    if (condition === 'permission') d.model.agentPermissions.progressiveEnabled = false;
    await expect(d.call.dialProgressiveLead('request-1')).resolves.toBe(false);
    expect(d.sdk.previewDial).not.toHaveBeenCalled();
  });

  it('requires microphone permission when preparing the integrated phone', async () => {
    const d = setup();
    d.evIntegratedSoftphone.askAudioPermission.mockResolvedValue(false);
    await expect(d.call.prepareProgressiveDial()).resolves.toBe(false);
  });
});
