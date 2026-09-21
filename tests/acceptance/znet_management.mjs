import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const playwrightEntry = process.env.ZNET_PLAYWRIGHT_ENTRY;
const managementPage = process.env.CONNECT_MANAGEMENT_PAGE;
const browserExecutable = process.env.ZNET_ACCEPTANCE_BROWSER;
if (!playwrightEntry || !managementPage || !browserExecutable) {
  throw new Error('management acceptance requires Playwright, page, and browser paths');
}

const {chromium} = await import(pathToFileURL(playwrightEntry).href);
const origin = 'https://panel.example.com';
const identityPublic = Buffer.alloc(32, 1);
const hpkePublic = Buffer.alloc(32, 2);
const now = Math.floor(Date.now() / 1000);
const fixture = {
  origin,
  now,
  capabilities: {
    protocol_version: 1,
    provider_id: origin,
    exchange_path: '/.well-known/zerodenet-connect/v1/exchange',
    operations: [
      'authorization.password', 'authorization.renew', 'subscriptions.list',
      'subscriptions.get-content', 'messages.list', 'messages.get', 'messages.mark-read',
    ],
    identity_public_key: identityPublic.toString('base64url'),
    identity_key_id: 'identity-1',
    identity_fingerprint: createHash('sha256').update(identityPublic).digest('base64url'),
    provider_key_statement: {
      protocol_version: 1,
      provider_id: origin,
      identity_key_id: 'identity-1',
      key_id: 'hpke-1',
      hpke_public_key: hpkePublic.toString('base64url'),
      not_before: now - 30,
      not_after: now + 3600,
      signature: Buffer.alloc(64, 3).toString('base64url'),
    },
  },
};

const browser = await chromium.launch({headless: true, executablePath: browserExecutable});
try {
  const context = await browser.newContext();
  await context.addInitScript(value => {
    const state = new Map();
    const secrets = new Map();
    const calls = [];
    let configuration = {};
    let lastRequest = null;
    let messageRead = false;
    const bytes = (length, fill) => new Uint8Array(length).fill(fill);
    const standardBase64 = input => {
      let binary = '';
      for (const byte of input) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const fromBase64 = input => Uint8Array.from(atob(input), char => char.charCodeAt(0));
    const base64Url = input => standardBase64(input).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const responseBody = operation => {
      if (operation === 'authorization.password') {
        if (lastRequest.authorization.credential !== 'correct horse' || lastRequest.body.account !== 'user@example.com') {
          throw new Error('management page sent unexpected credentials');
        }
        return {
          user_id: '42', device_id: lastRequest.device_id,
          access_credential: 'access-token', access_expires_at: value.now + 3600,
          renewal_credential: 'renewal-token', renewal_expires_at: value.now + 7200,
        };
      }
      if (operation === 'authorization.renew') {
        return {
          user_id: '42', device_id: lastRequest.device_id,
          access_credential: 'access-token-2', access_expires_at: value.now + 3600,
          renewal_credential: 'renewal-token-2', renewal_expires_at: value.now + 7200,
        };
      }
      if (operation === 'subscriptions.list') {
        return {subscriptions: [{subscription_id: '7', display_name: 'Pro', format: 'znet-sink', revision: 'r1'}]};
      }
      if (operation === 'subscriptions.get-content') {
        return {
          subscription_id: '7', display_name: 'Pro', format: 'znet-sink', revision: 'r1',
          content_sha256: 'fixture', content: 'version: 1\nproxies: []\n', not_modified: false,
        };
      }
      if (operation === 'messages.list') {
        return {messages: [{message_id: '9', title: 'Acceptance notice', published_at: value.now, read_at: messageRead ? value.now : null}], next_cursor: null};
      }
      if (operation === 'messages.get') {
        return {message_id: '9', title: 'Acceptance notice', body: 'Installed management flow works.', published_at: value.now, read_at: messageRead ? value.now : null};
      }
      if (operation === 'messages.mark-read') {
        messageRead = true;
        return {message_id: '9', read_at: value.now};
      }
      throw new Error(`unexpected Connect operation ${operation}`);
    };
    const capabilityCall = async (_component, _capability, _scope, method, args) => {
      calls.push({method, args: structuredClone(args)});
      if (method === 'configured_request') {
        if (args.url === `${value.origin}/.well-known/zerodenet-connect/v1/capabilities`) {
          return {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(value.capabilities)};
        }
        if (args.url !== `${value.origin}/.well-known/zerodenet-connect/v1/exchange`) throw new Error(`unexpected URL ${args.url}`);
        const envelope = JSON.parse(args.body);
        if (!lastRequest || envelope.request_id !== lastRequest.request_id) throw new Error('request correlation mismatch');
        return {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify({
          protocol_version: 1, suite: envelope.suite, key_id: envelope.key_id,
          request_id: envelope.request_id, encapsulation: base64Url(bytes(32, 8)), ciphertext: base64Url(bytes(48, 9)),
        })};
      }
      if (method === 'crypto_digest') {
        const digest = await crypto.subtle.digest('SHA-256', fromBase64(args.dataBase64));
        return {digestBase64: standardBase64(new Uint8Array(digest))};
      }
      if (method === 'crypto_verify') return {valid: true};
      if (method === 'crypto_key_generate') return {algorithm: 'ed25519', publicKeyBase64: standardBase64(bytes(32, 4))};
      if (method === 'crypto_hpke_key_generate') return {privateKeyHandle: 'response-key', publicKeyBase64: standardBase64(bytes(32, 5))};
      if (method === 'crypto_sign') return {signatureBase64: standardBase64(bytes(64, 6))};
      if (method === 'crypto_hpke_seal') {
        lastRequest = JSON.parse(new TextDecoder().decode(fromBase64(args.plaintextBase64)));
        return {encapsulationBase64: standardBase64(bytes(32, 7)), ciphertextBase64: standardBase64(bytes(48, 7))};
      }
      if (method === 'crypto_hpke_open') {
        const body = responseBody(lastRequest.operation);
        return {plaintextBase64: standardBase64(new TextEncoder().encode(JSON.stringify({
          protocol_version: 1, operation: lastRequest.operation, request_id: lastRequest.request_id,
          issued_at: value.now, expires_at: value.now + 60, status: 'ok', body,
        })))};
      }
      if (method === 'persistent_secret_get') {
        const secret = secrets.get(args.key);
        return secret == null ? null : {valueBase64: standardBase64(new TextEncoder().encode(secret))};
      }
      if (method === 'persistent_secret_put') {
        secrets.set(args.key, new TextDecoder().decode(fromBase64(args.valueBase64)));
        return true;
      }
      if (method === 'persistent_secret_delete') return secrets.delete(args.key);
      if (method === 'subscription_apply') {
        return {id: 'connect:panel-example:7', name: `${args.sourceName} / ${args.subscriptionName}`};
      }
      if (method === 'subscription_remove' || method === 'schedule_put' || method === 'schedule_delete' || method === 'notification_post') return true;
      throw new Error(`unexpected host SDK method ${method}`);
    };
    globalThis.znetPlugin = {
      navigation: {initial: () => null},
      configuration: {
        get: async () => structuredClone(configuration),
        save: async (_component, next) => { configuration = structuredClone(next); return structuredClone(configuration); },
      },
      storage: {
        getJson: async (_component, _area, key) => structuredClone(state.get(key) ?? null),
        putJson: async (_component, _area, key, next) => { state.set(key, structuredClone(next)); return true; },
        delete: async (_component, _area, key) => state.delete(key),
      },
      capabilities: {call: capabilityCall},
    };
    globalThis.__connectAcceptanceSnapshot = () => ({
      configuration: structuredClone(configuration),
      state: Object.fromEntries([...state.entries()].map(([key, item]) => [key, structuredClone(item)])),
      secrets: Object.fromEntries(secrets),
      calls: structuredClone(calls),
      messageRead,
    });
  }, fixture);

  const page = await context.newPage();
  await page.goto(pathToFileURL(managementPage).href);
  await page.locator('#view-sources').waitFor({state: 'visible'});
  await page.locator('#addSource').click();
  await page.locator('#sourceName').fill('Acceptance ZBoard');
  await page.locator('#providerOrigin').fill(origin);
  await page.locator('#networkPath').click();
  await page.locator('[data-znet-select-option][data-value="core"]').click();
  assert.equal(await page.locator('#networkPathValue').textContent(), '通过代理内核');
  await page.locator('#networkPath').click();
  await page.locator('[data-znet-select-option][data-value="direct"]').click();
  await page.locator('#save').click();
  await page.locator('#view-account').waitFor({state: 'visible'});
  assert.match(await page.locator('#accountSource').textContent(), /Acceptance ZBoard/u);
  assert.equal(await page.locator('#accountPath').textContent(), '直接连接');
  await page.locator('#account').fill('user@example.com');
  await page.locator('#password').fill('correct horse');
  await page.locator('#login').click();
  await page.locator('#view-subscriptions').waitFor({state: 'visible'});
  assert.equal(await page.locator('#password').inputValue(), '');
  assert.match(await page.locator('#subscriptionList').textContent(), /Pro/u);
  await page.locator('#bindSubscription').click();
  await page.locator('#view-complete').waitFor({state: 'visible'});
  assert.equal(await page.locator('#completeName').textContent(), 'Acceptance ZBoard / Pro');
  assert.match(await page.locator('#messageList').textContent(), /Acceptance notice/u);
  await page.locator('#messageList button', {hasText: '查看'}).click();
  await page.locator('#messageDetail').waitFor({state: 'visible'});
  assert.equal(await page.locator('#messageDetailBody').textContent(), 'Installed management flow works.');

  const snapshot = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.deepEqual(JSON.parse(snapshot.configuration.provider_origins), [origin]);
  const source = snapshot.state['sources/index'][0];
  assert.equal(source.network_path, 'direct');
  assert.equal(snapshot.state[`source/${source.id}/subscription/binding`].id, 'connect:panel-example:7');
  assert.equal(snapshot.state[`source/${source.id}/messages/summary`].items[0].message_id, '9');
  assert.equal(snapshot.messageRead, true);
  assert.equal(Object.values(snapshot.secrets).includes('correct horse'), false);
  assert.ok(snapshot.calls.some(call => call.method === 'subscription_apply'));
  assert.ok(snapshot.calls.some(call => call.method === 'schedule_put'));
  assert.ok(snapshot.calls.some(call => call.method === 'notification_post'));

  await page.locator('#backCompleteSources').click();
  await page.locator('#view-sources').waitFor({state: 'visible'});
  assert.match(await page.locator('#sourceList').textContent(), /已连接/u);
  assert.match(await page.locator('#sourceList').textContent(), /查看连接/u);

  const failingPage = await context.newPage();
  await failingPage.goto(pathToFileURL(managementPage).href);
  await failingPage.locator('#addSource').click();
  await failingPage.locator('#sourceName').fill('Core route ZBoard');
  await failingPage.locator('#providerOrigin').fill(origin);
  await failingPage.locator('#networkPath').click();
  await failingPage.locator('[data-znet-select-option][data-value="core"]').click();
  await failingPage.evaluate(() => {
    const original = globalThis.znetPlugin.capabilities.call;
    globalThis.znetPlugin.capabilities.call = (...args) => {
      if (args[3] === 'configured_request' && args[4]?.route === 'core') {
        throw new Error('插件操作失败：网络请求失败或元数据格式无效');
      }
      return original(...args);
    };
  });
  await failingPage.locator('#save').click();
  await failingPage.locator('#view-service').waitFor({state: 'visible'});
  const failureResult = await failingPage.locator('#serviceResult').textContent();
  assert.match(failureResult, /读取服务能力失败/u);
  assert.match(failureResult, /通过代理内核/u);
  assert.match(failureResult, /切换为“直接连接”/u);
  assert.match(failureResult, /客户端返回：插件操作失败：网络请求失败或元数据格式无效/u);
  console.log('ZNet Sink installed management-page flow passed.');
} finally {
  await browser.close();
}
