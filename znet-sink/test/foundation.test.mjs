import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

test('declarative source configuration excludes keys and account credentials', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package/manifest.template.json', import.meta.url), 'utf8'));
  const ids = manifest.configuration.fields.map((field) => field.id);
  assert.deepEqual(ids, ['provider_origins']);
  assert.equal(ids.includes('server_key_fingerprint'), false);
  assert.equal(ids.includes('username'), false);
  assert.equal(ids.includes('password'), false);
  assert.ok(manifest.required.some(permission => permission.capability === 'tasks.schedule' && permission.scope === 'self'));
});

test('provider component owns a page-independent scheduled synchronization action', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("invocation.action.startsWith('lifecycle.scheduled.sync.')"));
  assert.ok(source.includes('hostSdkCall'));
  assert.ok(source.includes("'subscriptions.get-content'"));
  assert.ok(source.includes("'messages.list'"));
  assert.ok(source.includes("'subscription_apply'"));
  const result = vm.runInNewContext(source, {
    hostSdkCall: () => { throw new Error('scheduled action must not call the host before interactive setup'); },
    pluginInput: {
      configuration: {provider_origins: '["https://panel.example.com"]'},
      state: {'sources/index': JSON.stringify([{id: 'source-1', name: 'Panel', origin: 'https://panel.example.com', network_path: 'direct'}])},
      invocation: {action: 'lifecycle.scheduled.sync.source-1', payload: {taskId: 'connect-sync-source-1'}, now_unix_ms: Date.now()},
    },
  }, {timeout: 100});
  assert.equal(result.value.skipped, true);
  assert.equal(result.value.reason, 'interactive_setup_required');
});

test('scheduled action refreshes one managed binding and message summary through typed host calls', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  const origin = 'https://panel.example.com';
  const identityPublic = Buffer.alloc(32, 1);
  const hpkePublic = Buffer.alloc(32, 2);
  const identityFingerprint = createHash('sha256').update(identityPublic).digest('base64url');
  const now = Math.floor(Date.now() / 1000);
  const statement = {
    protocol_version: 1,
    provider_id: origin,
    identity_key_id: 'identity-1',
    key_id: 'hpke-1',
    hpke_public_key: hpkePublic.toString('base64url'),
    not_before: now - 30,
    not_after: now + 3600,
    signature: Buffer.alloc(64, 3).toString('base64url'),
  };
  const capabilities = {
    protocol_version: 1,
    provider_id: origin,
    exchange_path: '/.well-known/zerodenet-connect/v1/exchange',
    operations: ['authorization.password', 'authorization.renew', 'subscriptions.list', 'subscriptions.get-content', 'messages.list'],
    identity_public_key: identityPublic.toString('base64url'),
    identity_key_id: 'identity-1',
    identity_fingerprint: identityFingerprint,
    provider_key_statement: statement,
  };
  const pin = JSON.stringify({
    provider_id: origin,
    identity_key_id: 'identity-1',
    identity_public_key: identityPublic.toString('base64url'),
    identity_fingerprint: identityFingerprint,
  });
  const methods = [];
  let exchangeCount = 0;
  let responseRequestId = '';
  const hostSdkCall = raw => {
    const call = JSON.parse(raw);
    methods.push(call.method);
    const ok = value => JSON.stringify({version: 1, ok: true, value});
    switch (call.method) {
      case 'persistent_secret_get': {
        const values = {'source/source-1/trust/provider': pin, 'source/source-1/session/access': 'access-token'};
        const value = values[call.arguments.key];
        return ok(value == null ? null : {valueBase64: Buffer.from(value).toString('base64')});
      }
      case 'crypto_digest':
        return ok({digestBase64: createHash('sha256').update(Buffer.from(call.arguments.dataBase64, 'base64')).digest('base64')});
      case 'crypto_verify': return ok({valid: true});
      case 'crypto_key_generate': return ok({algorithm: 'ed25519', publicKeyBase64: Buffer.alloc(32, 4).toString('base64')});
      case 'crypto_hpke_key_generate': return ok({privateKeyHandle: `private-${methods.length}`, publicKeyBase64: Buffer.alloc(32, 5).toString('base64')});
      case 'crypto_sign': return ok({signatureBase64: Buffer.alloc(64, 6).toString('base64')});
      case 'crypto_hpke_seal': return ok({encapsulationBase64: Buffer.alloc(32, 7).toString('base64'), ciphertextBase64: Buffer.from('request').toString('base64')});
      case 'configured_request': {
        if (call.arguments.url.endsWith('/capabilities')) return ok({status: 200, headers: {}, body: JSON.stringify(capabilities)});
        const envelope = JSON.parse(call.arguments.body);
        responseRequestId = envelope.request_id;
        exchangeCount += 1;
        return ok({status: 200, headers: {}, body: JSON.stringify({
          protocol_version: 1, suite: envelope.suite, key_id: envelope.key_id,
          request_id: envelope.request_id, encapsulation: Buffer.alloc(32, 8).toString('base64url'),
          ciphertext: Buffer.from('response').toString('base64url'),
        })});
      }
      case 'crypto_hpke_open': {
        const operation = exchangeCount === 1 ? 'subscriptions.get-content' : 'messages.list';
        const body = exchangeCount === 1
          ? {not_modified: false, content: 'proxies: []', display_name: 'Primary', format: 'yaml', revision: 'rev-2'}
          : {messages: [{message_id: 'message-1', title: 'Hello', published_at: now, read_at: null}]};
        return ok({plaintextBase64: Buffer.from(JSON.stringify({
          protocol_version: 1, operation, request_id: responseRequestId,
          issued_at: now, expires_at: now + 60, status: 'ok', body,
        })).toString('base64')});
      }
      case 'subscription_apply': {
        assert.equal(Buffer.from(call.arguments.content, 'base64').toString('utf8'), 'proxies: []');
        return ok({id: 'managed-1', name: 'Panel / Primary'});
      }
      case 'notification_post': return ok(true);
      default: throw new Error(`unexpected SDK method ${call.method}`);
    }
  };
  const result = vm.runInNewContext(source, {
    hostSdkCall,
    pluginInput: {
      configuration: {provider_origins: JSON.stringify([origin])},
      state: {
        'sources/index': JSON.stringify([
          {id: 'source-1', name: 'Panel', origin, network_path: 'direct'},
          {id: 'source-2', name: 'Other', origin: 'https://other.example.com', network_path: 'core'},
        ]),
        'source/source-1/device/identity': JSON.stringify({device_id: 'device-1', source_id: 'source-1'}),
        'source/source-1/session/metadata': JSON.stringify({user_id: 'user-1', device_id: 'device-1', access_expires_at: now + 3600, renewal_expires_at: now + 7200}),
        'source/source-1/subscription/binding': JSON.stringify({id: 'managed-1', name: 'Panel / Primary', remote_subscription_id: 'subscription-1', revision: 'rev-1'}),
        'source/source-1/messages/summary': JSON.stringify({items: []}),
        'source/source-2/session/metadata': JSON.stringify({user_id: 'other-user'}),
        'source/source-2/subscription/binding': JSON.stringify({id: 'managed-2', remote_subscription_id: 'subscription-2'}),
      },
      invocation: {action: 'lifecycle.scheduled.sync.source-1', payload: {taskId: 'connect-sync-source-1'}, now_unix_ms: now * 1000},
    },
  }, {timeout: 1000});
  assert.equal(result.value.ok, true);
  assert.equal(result.value.changed, true);
  assert.equal(result.value.unread, 1);
  const decodeState = value => JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  assert.equal(decodeState(result.state_updates['source/source-1/subscription/binding']).revision, 'rev-2');
  assert.equal(decodeState(result.state_updates['source/source-1/messages/summary']).items[0].message_id, 'message-1');
  assert.equal(methods.filter(method => method === 'subscription_apply').length, 1);
  assert.equal(methods.filter(method => method === 'notification_post').length, 1);
  assert.ok(methods.includes('notification_post'));
  assert.equal(Object.keys(result.state_updates).some(key => key.startsWith('source/source-2/')), false);
});

test('provider component requires configuration before remote stages', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  const result = vm.runInNewContext(source, {pluginInput: {configuration: {}, invocation: {action: 'status.get'}}}, {timeout: 100});
  assert.equal(result.znet_plugin_result, 1);
  assert.equal(result.value.product_id, 'org.zerodenet.connect');
  assert.equal(result.value.phase, 'needs-configuration');
  assert.equal(result.value.checks[0].state, 'action_required');
});

test('provider component delegates interactive verification to the signed management page', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  const configuredSource = {id:'source-1', name:'My panel', origin:'https://panel.example.com', network_path:'direct'};
  const configuration = {provider_origins: JSON.stringify([configuredSource.origin])};
  const result = vm.runInNewContext(source, {pluginInput: {configuration, state:{'sources/index':JSON.stringify([configuredSource])}, invocation: {action: 'status.get'}}}, {timeout: 100});
  assert.equal(result.value.sources[0].origin, configuredSource.origin);
  assert.equal(result.value.capability_gap, null);
  assert.equal(result.value.phase, 'needs-interactive-setup');
  assert.equal('server_key_fingerprint' in result.value.sources[0], false);
});

test('provider component reports persisted non-secret setup progress without remote polling', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  const configuration = {provider_origins:'["https://panel.example.com"]'};
  const state = {
    'sources/index':JSON.stringify([{id:'source-1', name:'Panel', origin:'https://panel.example.com', network_path:'direct'}]),
    'source/source-1/session/metadata':'opaque-base64',
    'source/source-1/subscription/binding':'opaque-base64',
    'source/source-1/messages/summary':'opaque-base64',
  };
  const result = vm.runInNewContext(source, {pluginInput: {configuration, state, invocation: {action: 'status.get'}}}, {timeout: 100});
  assert.equal(result.value.phase, 'ready');
  assert.equal(result.value.checks.find(item => item.id === 'subscription-binding').state, 'ready');
});

test('password authorization never returns or persists the submitted password', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  const secret = 'do-not-persist-this';
  const result = vm.runInNewContext(source, {pluginInput: {
    configuration: {provider_origins:'["https://panel.example.com"]'},
    state: {'sources/index':JSON.stringify([{id:'source-1', name:'Panel', origin:'https://panel.example.com', network_path:'direct'}])},
    invocation: {action: 'authorization.password', payload: {account: 'user@example.com', password: secret}},
  }}, {timeout: 100});
  assert.equal(result.value.code, 'interactive_page_required');
  assert.deepEqual(Object.keys(result.state_updates), []);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
