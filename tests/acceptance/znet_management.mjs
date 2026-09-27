import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const playwrightEntry = process.env.ZNET_PLAYWRIGHT_ENTRY;
const managementPage = process.env.CONNECT_MANAGEMENT_PAGE;
const managementStyle = process.env.CONNECT_MANAGEMENT_STYLE;
const managementScript = process.env.CONNECT_MANAGEMENT_SCRIPT;
const browserExecutable = process.env.ZNET_ACCEPTANCE_BROWSER;
if (!playwrightEntry || !managementPage || !managementStyle || !managementScript || !browserExecutable) {
  throw new Error('management acceptance requires Playwright, page, and browser paths');
}

const {chromium} = await import(pathToFileURL(playwrightEntry).href);
const origin = 'https://panel.example.com';
const identityPublic = Buffer.alloc(32, 1);
const hpkePublic = Buffer.alloc(32, 2);
const now = Math.floor(Date.now() / 1000);
const rawSubscription = JSON.stringify({outbounds: [{tag: 'direct', protocol: {type: 'direct'}}]});
const fixture = {
  origin,
  now,
  rawSubscription,
  capabilities: {
    protocol_version: 1,
    provider_id: origin,
    exchange_path: '/.well-known/zerodenet-connect/v1/exchange',
    operations: [
      'authorization.password', 'authorization.renew', 'account.me', 'subscriptions.list',
      'subscriptions.get-content', 'subscriptions.usage', 'messages.list', 'messages.get', 'messages.mark-read',
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
    const tasks = new Map();
    const calls = [];
    let configuration = {};
    let lastRequest = null;
    let messageRead = false;
    let failNextStateWrite = false;
    let failNextSessionStateWrite = false;
    let failNextSubscriptionList = false;
    let failNextSubscriptionRemoval = false;
    let failNextNotification = false;
    let communicationEnabled = true;
    let configurationSaves = 0;
    let rejectConcurrentStateReads = false;
    let activeStateReads = 0;
    const managedUsage = new Map();
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
      if (operation === 'account.me') return {user_id: '42', email: 'user@example.com'};
      if (operation === 'subscriptions.usage') return {
        subscription_id: lastRequest.body.subscription_id,
        used_bytes: 375, total_bytes: 1000, expire_at_unix_ms: 1800000000000,
      };
      if (operation === 'subscriptions.list') {
        return {subscriptions: [
          {subscription_id: '7', display_name: 'Pro', format: 'znet-sink', revision: 'r1'},
          {subscription_id: '8', display_name: 'Family', format: 'znet-sink', revision: 'r2'},
        ]};
      }
      if (operation === 'subscriptions.get-content') {
        return {
          subscription_id: lastRequest.body.subscription_id,
          display_name: lastRequest.body.subscription_id === '8' ? 'Family' : 'Pro',
          format: 'znet-sink', revision: lastRequest.body.subscription_id === '8' ? 'r2' : 'r1',
          content_sha256: 'fixture', content: value.rawSubscription, not_modified: false,
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
          if (!communicationEnabled) return {status: 503, headers: {}, body: JSON.stringify({error: 'communication_disabled'})};
          return {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(value.capabilities)};
        }
        if (args.url !== `${value.origin}/.well-known/zerodenet-connect/v1/exchange`) throw new Error(`unexpected URL ${args.url}`);
        if (lastRequest?.operation === 'subscriptions.list' && failNextSubscriptionList) {
          failNextSubscriptionList = false;
          throw new Error('fixture network request failed');
        }
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
        managedUsage.delete(args.remoteSubscriptionId);
        return {id: `connect:panel-example:${args.remoteSubscriptionId}`, name: `${args.sourceName} / ${args.subscriptionName}`};
      }
      if (method === 'subscription_metadata_update') {
        managedUsage.set(args.remoteSubscriptionId, structuredClone(args.usage));
        return {id: `connect:panel-example:${args.remoteSubscriptionId}`, ...args.usage};
      }
      if (method === 'schedule_list') return [...tasks.values()];
      if (method === 'schedule_put') {
        const task = {taskId: args.taskId, action: args.action, intervalSeconds: args.intervalSeconds};
        tasks.set(args.taskId, task);
        return task;
      }
      if (method === 'schedule_delete') return tasks.delete(args.taskId);
      if (method === 'subscription_remove') {
        if (failNextSubscriptionRemoval) {
          failNextSubscriptionRemoval = false;
          throw new Error('fixture removal failed');
        }
        return true;
      }
      if (method === 'notification_post') {
        if (failNextNotification) {
          failNextNotification = false;
          throw new Error('系统通知未获允许');
        }
        return true;
      }
      if (method === 'log_write') return true;
      throw new Error(`unexpected host SDK method ${method}`);
    };
    globalThis.znetPlugin = {
      navigation: {initial: () => null},
      configuration: {
        get: async () => structuredClone(configuration),
        save: async (_component, next) => { configurationSaves++; configuration = structuredClone(next); return structuredClone(configuration); },
      },
      storage: {
        getJson: async (_component, _area, key) => {
          activeStateReads++;
          try {
            if (rejectConcurrentStateReads) {
              await Promise.resolve();
              if (activeStateReads > 1) throw new Error('concurrent host state reads are not supported by this fixture');
            }
            return structuredClone(state.get(key) ?? null);
          } finally { activeStateReads--; }
        },
        putJson: async (_component, _area, key, next) => {
          if (key === 'sources/index' && failNextStateWrite) {
            failNextStateWrite = false;
            throw new Error('fixture state write failed');
          }
          if (key.endsWith('/session/metadata') && failNextSessionStateWrite) {
            failNextSessionStateWrite = false;
            throw new Error('fixture session state write failed');
          }
          state.set(key, structuredClone(next)); return true;
        },
        delete: async (_component, _area, key) => state.delete(key),
      },
      capabilities: {call: capabilityCall},
      logs: {write: (component, level, message, fields) =>
        capabilityCall(component, 'plugin.logs.write', 'self', 'log_write', {level, message, fields})},
    };
    globalThis.__connectAcceptanceSnapshot = () => ({
      configuration: structuredClone(configuration),
      configurationSaves,
      state: Object.fromEntries([...state.entries()].map(([key, item]) => [key, structuredClone(item)])),
      secrets: Object.fromEntries(secrets),
      tasks: Object.fromEntries(tasks),
      calls: structuredClone(calls),
      managedUsage: Object.fromEntries(managedUsage),
      messageRead,
    });
    globalThis.__connectAcceptanceFailNextStateWrite = () => { failNextStateWrite = true; };
    globalThis.__connectAcceptanceFailNextSessionStateWrite = () => { failNextSessionStateWrite = true; };
    globalThis.__connectAcceptanceFailNextSubscriptionList = () => { failNextSubscriptionList = true; };
    globalThis.__connectAcceptanceFailNextSubscriptionRemoval = () => { failNextSubscriptionRemoval = true; };
    globalThis.__connectAcceptanceFailNextNotification = () => { failNextNotification = true; };
    globalThis.__connectAcceptanceResetMessageSummary = sourceId => {
      state.set(`source/${sourceId}/messages/summary`, {items: []});
    };
    globalThis.__connectAcceptanceSetCommunication = enabled => { communicationEnabled = enabled; };
    globalThis.__connectAcceptanceRejectConcurrentStateReads = () => { rejectConcurrentStateReads = true; };
  }, fixture);

  const page = await context.newPage();
  await page.goto(pathToFileURL(managementPage).href);
  await page.addStyleTag({path: managementStyle});
  const signedScript = await readFile(managementScript);
  await page.addScriptTag({url: `data:text/javascript;base64,${signedScript.toString('base64')}`});
  await page.locator('#view-sources').waitFor({state: 'visible'});
  await page.locator('#addSource').click();
  await page.locator('#sourceName').fill('Acceptance ZBoard');
  await page.locator('#providerOrigin').fill(origin);
  await page.locator('#networkPath').click();
  await page.locator('[data-znet-select-option][data-value="core"]').click();
  await page.locator('[data-sync-interval="1800"]').click();
  assert.equal(await page.locator('#networkPathValue').textContent(), '通过代理内核');
  await page.evaluate(() => globalThis.__connectAcceptanceFailNextStateWrite());
  await page.locator('#save').click();
  await page.locator('#notice').getByText('来源未保存，已恢复先前配置', {exact: false}).waitFor();
  const failedSave = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.deepEqual(failedSave.configuration, {provider_origins: '[]'});
  assert.deepEqual(failedSave.state['sources/index'], []);
  assert.equal(await page.locator('#view-source').isVisible(), true);
  await page.locator('#save').click();
  await page.locator('#continueAccount').waitFor({state: 'visible'});
  assert.equal(await page.locator('#serviceTitle').textContent(), '服务已确认');
  await page.locator('#continueAccount').click();
  await page.locator('#account').fill('user@example.com');
  await page.locator('#password').fill('correct horse');
  await page.evaluate(() => globalThis.__connectAcceptanceFailNextSessionStateWrite());
  await page.locator('#login').click();
  await page.locator('#notice').getByText('保存设备会话失败', {exact: false}).waitFor();
  const partialSession = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  const pendingSource = partialSession.state['sources/index'][0];
  assert.equal(partialSession.state[`source/${pendingSource.id}/session/metadata`], undefined);
  assert.equal(partialSession.secrets[`source/${pendingSource.id}/session/access`], undefined);
  assert.equal(partialSession.secrets[`source/${pendingSource.id}/session/renewal`], undefined);
  assert.equal(await page.locator('#view-account').isVisible(), true);
  await page.locator('#password').fill('correct horse');
  await page.evaluate(() => globalThis.__connectAcceptanceFailNextSubscriptionList());
  await page.locator('#login').click();
  await page.locator('#view-subscriptions').waitFor({state: 'visible'});
  assert.equal(await page.locator('#password').inputValue(), '');
  assert.match(await page.locator('#notice').textContent(), /设备已授权.*提交加密请求.*通过代理内核/u);
  const authorized = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.ok(authorized.state[`source/${pendingSource.id}/session/metadata`]);
  await page.locator('#retrySubscriptions').click();
  assert.match(await page.locator('#subscriptionList').textContent(), /Pro/u);
  await page.locator('#bindSubscription').click();
  await page.locator('#view-complete').waitFor({state: 'visible'});
  assert.equal(await page.locator('#completeName').textContent(), 'Acceptance ZBoard / Pro');
  assert.equal(await page.locator('#completeAccount').textContent(), 'user@example.com');
  assert.deepEqual((await page.evaluate(() => globalThis.__connectAcceptanceSnapshot())).managedUsage['7'],
    {usedBytes: 375, totalBytes: 1000, expireAtUnixMs: 1800000000000});
  await page.evaluate(sourceId => {
    globalThis.__connectAcceptanceResetMessageSummary(sourceId);
    globalThis.__connectAcceptanceFailNextNotification();
  }, pendingSource.id);
  await page.locator('#syncNow').click();
  await page.locator('#notice').getByText('新消息已同步，但系统提醒未送达', {exact: false}).waitFor();
  const failedNotification = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.equal(failedNotification.state[`source/${pendingSource.id}/messages/summary`].items[0].message_id, '9');
  assert.ok(failedNotification.calls.some(call => call.method === 'log_write' &&
    call.args.message === 'Connect 消息已同步，通知未送达'));
  const notificationCount = failedNotification.calls.filter(call => call.method === 'notification_post').length;
  await page.locator('#syncNow').click();
  await page.locator('#notice[data-znet-notice="success"]').waitFor();
  const repeated = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.equal(repeated.calls.filter(call => call.method === 'notification_post').length, notificationCount);
  assert.deepEqual((await page.evaluate(() => globalThis.__connectAcceptanceSnapshot())).managedUsage['7'],
    {usedBytes: 375, totalBytes: 1000, expireAtUnixMs: 1800000000000});
  await page.locator('#changeSubscription').click();
  await page.locator('#view-subscriptions').waitFor({state: 'visible'});
  assert.match(await page.locator('#subscriptionList').textContent(), /Pro（当前）/u);
  await page.locator('input[name="connect-subscription"][value="8"]').check();
  await page.evaluate(() => globalThis.__connectAcceptanceFailNextSubscriptionRemoval());
  await page.locator('#bindSubscription').click();
  await page.locator('#view-complete').waitFor({state: 'visible'});
  assert.equal(await page.locator('#completeName').textContent(), 'Acceptance ZBoard / Family');
  const switched = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.equal(switched.state[`source/${pendingSource.id}/subscription/binding`].remote_subscription_id, '8');
  assert.equal(switched.state[`source/${pendingSource.id}/subscription/pending_removal`].id, 'connect:panel-example:7');
  assert.match(await page.locator('#notice').textContent(), /旧订阅移除失败/u);
  await page.locator('#backCompleteSources').click();
  await page.locator('#sourceList button', {hasText: '查看连接'}).click();
  await page.locator('#view-complete').waitFor({state: 'visible'});
  const retried = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.equal(retried.state[`source/${pendingSource.id}/subscription/pending_removal`], undefined);
  assert.ok(retried.calls.some(call => call.method === 'subscription_remove' && call.args.subscriptionId === 'connect:panel-example:7'));
  assert.match(await page.locator('#messageList').textContent(), /Acceptance notice/u);
  await page.locator('#messageList button', {hasText: '查看'}).click();
  await page.locator('#messageDialog').waitFor({state: 'visible'});
  assert.equal(await page.locator('#messageDetailBody').textContent(), 'Installed management flow works.');
  await page.locator('#closeMessage').click();
  await page.locator('#messageDialog').waitFor({state: 'hidden'});

  await page.locator('#backCompleteSources').click();
  await page.evaluate(() => globalThis.__connectAcceptanceRejectConcurrentStateReads());
  await page.locator('#sourceList button', {hasText: '查看连接'}).click();
  await page.locator('#view-complete').waitFor({state: 'visible'});
  let scheduled = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  const configurationSavesBeforeIntervalEdit = scheduled.configurationSaves;
  assert.equal(scheduled.calls.filter(call => call.method === 'schedule_put').length, 3);
  assert.deepEqual(Object.values(scheduled.tasks).map(task => task.intervalSeconds), [1800, 1800, 1800]);
  await page.locator('#manageSource').click();
  await page.locator('[data-sync-interval="21600"]').click();
  await page.locator('#save').click();
  await page.locator('#view-sources').waitFor({state: 'visible'});
  scheduled = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.deepEqual(Object.values(scheduled.tasks).map(task => task.intervalSeconds), [21600, 21600, 21600]);
  assert.equal(scheduled.calls.filter(call => call.method === 'schedule_put').length, 6);
  assert.equal(scheduled.configurationSaves, configurationSavesBeforeIntervalEdit);
  assert.match(await page.locator('#notice').textContent(), /来源设置已保存，自动同步：每 6 小时/u);
  await page.locator('#sourceList button', {hasText: '管理来源'}).click();
  await page.locator('#view-source').waitFor({state: 'visible'});
  await page.locator('[data-sync-interval="0"]').click();
  await page.locator('#save').click();
  scheduled = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.deepEqual(scheduled.tasks, {});
  assert.ok(scheduled.calls.some(call => call.method === 'schedule_delete'));
  assert.equal(scheduled.configurationSaves, configurationSavesBeforeIntervalEdit);
  await page.locator('#sourceList button', {hasText: '管理来源'}).click();
  await page.locator('[data-sync-interval="3600"]').click();
  await page.locator('#save').click();
  scheduled = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.deepEqual(Object.values(scheduled.tasks).map(task => task.intervalSeconds), [3600, 3600, 3600]);
  assert.equal(scheduled.configurationSaves, configurationSavesBeforeIntervalEdit);

  await page.evaluate(() => globalThis.__connectAcceptanceSetCommunication(false));
  await page.locator('#sourceList button', {hasText: '查看连接'}).click();
  await page.locator('#view-service').waitFor({state: 'visible'});
  assert.equal(await page.locator('#serviceTitle').textContent(), 'ZBoard 尚未启用 Connect');
  await page.evaluate(() => globalThis.__connectAcceptanceSetCommunication(true));

  const snapshot = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.deepEqual(JSON.parse(snapshot.configuration.provider_origins), [origin]);
  const source = snapshot.state['sources/index'][0];
  assert.equal(source.network_path, 'core');
  assert.ok(snapshot.calls.some(call => call.method === 'configured_request' &&
    call.args.url.endsWith('/exchange') && call.args.route === 'core'));
  assert.equal(snapshot.state[`source/${source.id}/subscription/binding`].id, 'connect:panel-example:8');
  assert.equal(snapshot.state[`source/${source.id}/messages/summary`].items[0].message_id, '9');
  assert.equal(snapshot.messageRead, true);
  assert.equal(Object.values(snapshot.secrets).includes('correct horse'), false);
  const applied = snapshot.calls.find(call => call.method === 'subscription_apply');
  assert.ok(applied);
  assert.equal(applied.args.format, 'znet-sink');
  assert.equal(Buffer.from(applied.args.content, 'base64').toString('utf8'), rawSubscription);
  assert.ok(snapshot.calls.some(call => call.method === 'schedule_put'));
  assert.ok(snapshot.calls.some(call => call.method === 'notification_post'));
  const logEntries = snapshot.calls.filter(call => call.method === 'log_write');
  assert.ok(logEntries.some(call => call.args.message === 'Connect 手动同步完成' &&
    call.args.fields.action === 'syncNow'));
  assert.ok(logEntries.some(call => call.args.message === 'Connect 订阅关联需关注' &&
    call.args.fields.action === 'bindSubscription'));
  assert.equal(JSON.stringify(logEntries).includes('correct horse'), false);
  assert.equal(JSON.stringify(logEntries).includes('user@example.com'), false);

  await page.locator('#backServiceSources').click();
  await page.locator('#addSource').click();
  await page.locator('#sourceName').fill('Other ZBoard');
  await page.locator('#providerOrigin').fill('https://other.example.com');
  await page.locator('#save').click();
  await page.locator('#backServiceSources').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#sourceList button[aria-label="移除来源 Acceptance ZBoard"]').click();
  const removed = await page.evaluate(() => globalThis.__connectAcceptanceSnapshot());
  assert.equal(removed.state['sources/index'].length, 1);
  assert.equal(removed.state['sources/index'][0].name, 'Other ZBoard');
  assert.deepEqual(JSON.parse(removed.configuration.provider_origins), ['https://other.example.com']);
  assert.deepEqual(removed.tasks, {});
  assert.equal(removed.state[`source/${source.id}/subscription/binding`], undefined);
  assert.ok(removed.calls.some(call => call.method === 'subscription_remove' &&
    call.args.subscriptionId === 'connect:panel-example:8' && call.args.removeAssociatedConfig === true));
  const stickyNotice = await page.locator('[data-znet-settings-content]').evaluate(container => {
    container.style.height = '240px';
    container.style.overflow = 'auto';
    document.getElementById('sourceList').style.minHeight = '900px';
    container.scrollTop = container.scrollHeight;
    const bounds = container.getBoundingClientRect();
    const notice = document.getElementById('notice');
    return {position: getComputedStyle(notice).position, top: notice.getBoundingClientRect().top, containerTop: bounds.top};
  });
  assert.equal(stickyNotice.position, 'sticky');
  assert.ok(stickyNotice.top >= stickyNotice.containerTop && stickyNotice.top < stickyNotice.containerTop + 20);
  console.log('ZNet Sink installed management-page flow passed.');
} finally {
  await browser.close();
}
