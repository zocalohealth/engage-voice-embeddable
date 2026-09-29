jest.mock('@ringcentral-integration/next-core', () => ({ createSharedApp: jest.fn(async (config) => config) }));
jest.mock('../../../src/app/getAppConfig', () => ({ getAppConfig: jest.fn((config) => config) }));
import { webcrypto } from 'crypto';
import { createApp } from '../../../src/createApp';

const config = {
  prefix: 'ringcx', sdkConfig: {}, evAgentConfig: {}, brandConfig: {}, agentAssistantConfig: {},
};

async function shareFor(search: string, port: 'client' | 'server' = 'client') {
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { location: { href: `https://widget.test/app.html?${search}`, search: `?${search}` } } });
  const app = await createApp({ name: 'cx-embeddable', type: 'SharedWorker', port });
  return (app as any).share.name;
}

const originalEnv = process.env;
const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  process.env = { ...originalEnv, APP_CONFIG: config } as any;
});
afterAll(() => {
  process.env = originalEnv;
  if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
  else delete (globalThis as any).self;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete (globalThis as any).crypto;
});

it('isolates reload channels for different OAuth configurations', async () => {
  expect(await shareFor('clientId=production')).not.toBe(await shareFor('clientId=preview'));
});
it('isolates different worker feature configurations', async () => {
  expect(await shareFor('clientId=production&enableSideWidget=1')).not.toBe(await shareFor('clientId=production'));
});
it('keeps worker and popup on the same channel despite parameter order and timestamps', async () => {
  expect(await shareFor('rcServer=server&clientId=production', 'server'))
    .toBe(await shareFor('clientId=production&fromPopup=1&_t=123&rcServer=server&fromAdapter=1'));
});
