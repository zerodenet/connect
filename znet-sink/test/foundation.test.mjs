import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import connectComponent from '../src/foundation.mjs';

const backgroundSource = await readFile(new URL('../src/background.mjs', import.meta.url), 'utf8');
const runComponent = context => {
  const previousInput = globalThis.pluginInput;
  const previousSdk = globalThis.hostSdkCall;
  try {
    globalThis.pluginInput = context.pluginInput;
    globalThis.hostSdkCall = context.hostSdkCall;
    return connectComponent();
  } finally {
    globalThis.pluginInput = previousInput;
    globalThis.hostSdkCall = previousSdk;
  }
};

test('declarative source configuration excludes keys and account credentials', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package/manifest.template.json', import.meta.url), 'utf8'));
  const ids = manifest.configuration.fields.map((field) => field.id);
  assert.deepEqual(ids, ['provider_origins']);
  assert.equal(ids.includes('server_key_fingerprint'), false);
  assert.equal(ids.includes('username'), false);
  assert.equal(ids.includes('password'), false);
  assert.ok(manifest.required.some(permission => permission.capability === 'tasks.schedule' && permission.scope === 'self'));
  assert.ok(manifest.required.some(permission => permission.capability === 'plugin.logs.write' && permission.scope === 'self'));
});

test('provider component owns a page-independent scheduled synchronization action', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("['lifecycle.scheduled.sync.', 'subscription']"));
  assert.ok(source.includes("['lifecycle.scheduled.usage.', 'usage']"));
  assert.ok(source.includes("['lifecycle.scheduled.messages.', 'messages']"));
  assert.ok(source.includes("import {scheduledSync} from './background.mjs'"));
  assert.ok(backgroundSource.includes('hostSdkCall'));
  assert.ok(backgroundSource.includes("'subscriptions.get-content'"));
  assert.ok(backgroundSource.includes("'messages.list'"));
  assert.ok(backgroundSource.includes("'subscription_apply'"));
  const result = runComponent({
    hostSdkCall: () => { throw new Error('scheduled action must not call the host before interactive setup'); },
    pluginInput: {
      configuration: {provider_origins: '["https://panel.example.com"]'},
      state: {'sources/index': JSON.stringify([{id: 'source-1', name: 'Panel', origin: 'https://panel.example.com', network_path: 'direct'}])},
      invocation: {action: 'lifecycle.scheduled.sync.source-1', payload: {taskId: 'connect-sync-source-1'}, now_unix_ms: Date.now()},
    },
  });
  assert.equal(result.value.skipped, true);
  assert.equal(result.value.reason, 'interactive_setup_required');
});

test('scheduled actions refresh usage, binding and messages separately within the host call budget', async () => {
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
    operations: ['authorization.password', 'authorization.renew', 'subscriptions.list', 'subscriptions.get-content', 'subscriptions.usage', 'messages.list'],
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
  const logged = [];
  const rawSubscription = JSON.stringify({outbounds: [{tag: 'direct', protocol: {type: 'direct'}}]});
  let subscriptionContent = rawSubscription;
  let appliedSubscription = null;
  let metadataUpdate = null;
  let managedUsage = null;
  let unchanged = false;
  let contentUnavailable = false;
  let reportedUsedBytes = 375;
  let postedNotification = null;
  let notificationFailureCode = '';
  let revokeAuthorization = false;
  let currentOperation = '';
  const subscriptionRequests = [];
  let responseRequestId = '';
  let callsInInvocation = 0;
  let renewAccess = false;
  const scheduledTasks = new Map();
  const hostSdkCall = raw => {
    const call = JSON.parse(raw);
    callsInInvocation += 1;
    if (callsInInvocation > 32) throw new Error('BudgetExceeded');
    methods.push(call.method);
    const ok = value => JSON.stringify({version: 1, ok: true, value});
    switch (call.method) {
      case 'persistent_secret_get': {
        const values = {
          'source/source-1/trust/provider': pin,
          'source/source-1/session/access': renewAccess ? null : 'access-token',
          'source/source-1/session/renewal': 'renewal-token',
        };
        const value = values[call.arguments.key];
        return ok(value == null ? null : {valueBase64: Buffer.from(value).toString('base64')});
      }
      case 'persistent_secret_put': return ok(true);
      case 'persistent_secret_delete': return ok(true);
      case 'schedule_list': return ok([...scheduledTasks.values()]);
      case 'schedule_put':
        scheduledTasks.set(call.arguments.taskId, call.arguments);
        return ok(call.arguments);
      case 'crypto_digest':
        return ok({digestBase64: createHash('sha256').update(Buffer.from(call.arguments.dataBase64, 'base64')).digest('base64')});
      case 'crypto_verify': return ok({valid: true});
      case 'crypto_key_generate': return ok({algorithm: 'ed25519', publicKeyBase64: Buffer.alloc(32, 4).toString('base64')});
      case 'crypto_hpke_key_generate': return ok({privateKeyHandle: `private-${methods.length}`, publicKeyBase64: Buffer.alloc(32, 5).toString('base64')});
      case 'crypto_sign': return ok({signatureBase64: Buffer.alloc(64, 6).toString('base64')});
      case 'crypto_hpke_seal': {
        const request = JSON.parse(Buffer.from(call.arguments.plaintextBase64, 'base64').toString('utf8'));
        currentOperation = request.operation;
        if (request.operation === 'subscriptions.get-content') subscriptionRequests.push(request.body);
        return ok({encapsulationBase64: Buffer.alloc(32, 7).toString('base64'), ciphertextBase64: Buffer.from('request').toString('base64')});
      }
      case 'configured_request': {
        if (call.arguments.url.endsWith('/capabilities')) return ok({status: 200, headers: {}, body: JSON.stringify(capabilities)});
        const envelope = JSON.parse(call.arguments.body);
        responseRequestId = envelope.request_id;
        return ok({status: 200, headers: {}, body: JSON.stringify({
          protocol_version: 1, suite: envelope.suite, key_id: envelope.key_id,
          request_id: envelope.request_id, encapsulation: Buffer.alloc(32, 8).toString('base64url'),
          ciphertext: Buffer.from('response').toString('base64url'),
        })});
      }
      case 'crypto_hpke_open': {
        const operation = currentOperation;
        const body = operation === 'authorization.renew'
          ? {user_id: 'user-1', device_id: 'device-1', access_credential: 'new-access', renewal_credential: 'new-renewal', access_expires_at: now + 3600, renewal_expires_at: now + 7200}
          : operation === 'subscriptions.usage'
          ? {subscription_id: 'subscription-1', used_bytes: reportedUsedBytes, total_bytes: 1000, expire_at_unix_ms: 1800000000000}
          : operation === 'subscriptions.get-content'
            ? (unchanged ? {not_modified: true, revision: 'rev-2'}
              : {not_modified: false, content: subscriptionContent, display_name: 'Primary', format: 'znet-sink', revision: 'rev-2'})
          : {messages: [{message_id: 'message-1', title: 'Hello', published_at: now, read_at: null}]};
        return ok({plaintextBase64: Buffer.from(JSON.stringify({
          protocol_version: 1, operation, request_id: responseRequestId,
          issued_at: now, expires_at: now + 60,
          status: (revokeAuthorization && operation === 'messages.list') ||
            (contentUnavailable && operation === 'subscriptions.get-content') ? 'error' : 'ok',
          ...(revokeAuthorization && operation === 'messages.list' ? {error: {code: 'authorization_revoked'}}
            : contentUnavailable && operation === 'subscriptions.get-content' ? {error: {code: 'not_found'}} : {body}),
        })).toString('base64')});
      }
      case 'subscription_apply':
        appliedSubscription = call.arguments;
        managedUsage = null;
        return ok({id: 'managed-1', name: 'Panel / Primary'});
      case 'subscription_metadata_update':
        metadataUpdate = call.arguments;
        managedUsage = call.arguments.usage;
        return ok({id: 'managed-1', usedBytes: 375, totalBytes: 1000});
      case 'subscription_sync_complete':
        assert.deepEqual(call.arguments, {
          providerId: origin, remoteSubscriptionId: 'subscription-1', revision: 'rev-2',
        });
        return ok({id: 'managed-1', lastSyncAtUnixMs: now * 1000});
      case 'notification_post':
        postedNotification = call.arguments;
        if (notificationFailureCode) return JSON.stringify({version: 1, ok: false, error: {
          code: notificationFailureCode, message: '系统通知未获允许',
        }});
        return ok(true);
      case 'log_write':
        logged.push(call);
        return ok(true);
      default: throw new Error(`unexpected SDK method ${call.method}`);
    }
  };
  const pluginInput = {
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
  };
  const runScheduled = kind => {
    callsInInvocation = 0;
    const result = runComponent({hostSdkCall, pluginInput: {
      ...pluginInput,
      invocation: {action: `lifecycle.scheduled.${kind}.source-1`, payload: {taskId: `connect-${kind}-source-1`}, now_unix_ms: now * 1000},
    }});
    assert.ok(callsInInvocation <= 32, `${kind} used ${callsInInvocation} host calls`);
    return result;
  };
  const usageResult = runScheduled('usage');
  assert.equal(usageResult.value.ok, true);
  const result = runScheduled('sync');
  const messageResult = runScheduled('messages');
  assert.equal(result.value.ok, true);
  assert.equal(result.value.changed, true);
  assert.deepEqual([...scheduledTasks.keys()], ['connect-usage-source-1', 'connect-messages-source-1']);
  assert.equal(scheduledTasks.get('connect-usage-source-1').intervalSeconds, 900);
  assert.equal(messageResult.value.unread, 1);
  const decodeState = value => JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  assert.equal(decodeState(result.state_updates['source/source-1/subscription/binding']).revision, 'rev-2');
  assert.deepEqual(decodeState(result.state_updates['source/source-1/subscription/applied_revision']), {
    remote_subscription_id: 'subscription-1', revision: 'rev-2',
  });
  assert.equal(subscriptionRequests[0].known_revision, null,
    'legacy binding without an applied marker must force one durable re-apply');
  assert.equal(decodeState(messageResult.state_updates['source/source-1/messages/summary']).items[0].message_id, 'message-1');
  assert.equal(methods.filter(method => method === 'subscription_apply').length, 1);
  assert.equal(methods.filter(method => method === 'subscription_metadata_update').length, 2);
  assert.ok(methods.lastIndexOf('subscription_metadata_update') > methods.lastIndexOf('subscription_apply'));
  assert.deepEqual(managedUsage, {usedBytes: 375, totalBytes: 1000, expireAtUnixMs: 1800000000000});
  assert.deepEqual(metadataUpdate.usage, {usedBytes: 375, totalBytes: 1000, expireAtUnixMs: 1800000000000});
  assert.equal(decodeState(usageResult.state_updates['source/source-1/subscription/usage_checked_at']), now * 1000);
  assert.equal(appliedSubscription.format, 'znet-sink');
  assert.equal(Buffer.from(appliedSubscription.content, 'base64').toString('utf8'), rawSubscription);
  assert.equal(methods.filter(method => method === 'notification_post').length, 1);
  assert.deepEqual(postedNotification.action, {
    pageId: 'manage', route: 'messages.source-1', reference: 'message-1',
  });
  assert.ok(methods.includes('notification_post'));
  assert.ok(logged.some(call => call.request.capability === 'plugin.logs.write' &&
    call.arguments.message === 'Connect 后台订阅同步完成' &&
    call.arguments.fields.task === 'subscription' &&
    call.arguments.fields.sourceId === 'source-1'));
  assert.ok(logged.some(call => call.arguments.message === 'Connect 后台用量同步完成'));
  assert.ok(logged.some(call => call.arguments.message === 'Connect 后台发现新消息' &&
    call.arguments.fields.newCount === 1));
  assert.equal(Object.keys(result.state_updates).some(key => key.startsWith('source/source-2/')), false);

  notificationFailureCode = 'plugin_system_notification_denied';
  const deniedNotification = runScheduled('messages');
  assert.equal(deniedNotification.value.ok, true);
  assert.equal(decodeState(deniedNotification.state_updates['source/source-1/messages/summary']).items[0].message_id, 'message-1');
  assert.ok(logged.some(call => call.arguments.message === 'Connect 后台通知未送达' &&
    call.arguments.fields.code === notificationFailureCode));
  pluginInput.state['source/source-1/messages/summary'] = Buffer.from(
    deniedNotification.state_updates['source/source-1/messages/summary'], 'base64').toString('utf8');
  const notificationCount = methods.filter(method => method === 'notification_post').length;
  const repeatMessages = runScheduled('messages');
  assert.equal(repeatMessages.value.ok, true);
  assert.equal(methods.filter(method => method === 'notification_post').length, notificationCount);

  revokeAuthorization = true;
  const revoked = runScheduled('messages');
  assert.equal(revoked.value.ok, false);
  assert.equal(revoked.value.retryable, false);
  assert.equal(revoked.state_updates['source/source-1/session/metadata'], null);
  assert.ok(methods.includes('persistent_secret_delete'));
  revokeAuthorization = false;
  notificationFailureCode = '';

  subscriptionContent = Buffer.from(rawSubscription).toString('base64');
  const encodedResult = runScheduled('sync');
  assert.equal(encodedResult.value.ok, true);
  assert.equal(appliedSubscription.content, subscriptionContent);

  pluginInput.state['source/source-1/subscription/binding'] = Buffer.from(
    result.state_updates['source/source-1/subscription/binding'], 'base64').toString('utf8');
  pluginInput.state['source/source-1/subscription/applied_revision'] = Buffer.from(
    result.state_updates['source/source-1/subscription/applied_revision'], 'base64').toString('utf8');
  unchanged = true;
  const appliesBefore = methods.filter(method => method === 'subscription_apply').length;
  const metadataBefore = methods.filter(method => method === 'subscription_metadata_update').length;
  const completedBefore = methods.filter(method => method === 'subscription_sync_complete').length;
  const unchangedResult = runScheduled('sync');
  assert.equal(unchangedResult.value.ok, true);
  assert.equal(unchangedResult.value.changed, false);
  assert.equal(methods.filter(method => method === 'subscription_apply').length, appliesBefore);
  assert.equal(methods.filter(method => method === 'subscription_metadata_update').length, metadataBefore);
  assert.equal(subscriptionRequests.at(-1).known_revision, 'rev-2');
  assert.equal(methods.filter(method => method === 'subscription_sync_complete').length, completedBefore + 1);
  assert.ok(logged.some(call => call.arguments.message === 'Connect 后台订阅同步完成' &&
    call.arguments.fields.changed === false));

  contentUnavailable = true;
  reportedUsedBytes = 1200;
  scheduledTasks.clear();
  const metadataBeforeUnavailable = methods.filter(method => method === 'subscription_metadata_update').length;
  runScheduled('usage');
  const unavailableResult = runScheduled('sync');
  assert.equal(unavailableResult.value.ok, false);
  assert.match(unavailableResult.value.message, /not_found/);
  assert.ok(logged.some(call => call.arguments.level === 'error' &&
    call.arguments.message === 'Connect 后台同步失败'));
  assert.equal(scheduledTasks.size, 2);
  assert.equal(methods.filter(method => method === 'subscription_metadata_update').length, metadataBeforeUnavailable + 1);
  assert.equal(metadataUpdate.usage.usedBytes, 1200);
  assert.equal(methods.filter(method => method === 'subscription_sync_complete').length, completedBefore + 1,
    'quota success must not record a failed content check as synchronized');

  const usageOperation = capabilities.operations.indexOf('subscriptions.usage');
  capabilities.operations.splice(usageOperation, 1);
  const metadataBeforeMissingCapability = methods.filter(method => method === 'subscription_metadata_update').length;
  const missingCapability = runScheduled('usage');
  assert.equal(missingCapability.value.updated, false);
  assert.equal(missingCapability.value.reason, 'provider_capability_unavailable');
  assert.equal(methods.filter(method => method === 'subscription_metadata_update').length, metadataBeforeMissingCapability);
  assert.match(decodeState(missingCapability.state_updates['source/source-1/subscription/usage_error']).message, /暂时无法显示流量和到期时间/);
  capabilities.operations.splice(usageOperation, 0, 'subscriptions.usage');

  contentUnavailable = false;
  unchanged = true;
  renewAccess = true;
  pluginInput.state['source/source-1/session/metadata'] = JSON.stringify({
    user_id: 'user-1', device_id: 'device-1', access_expires_at: now - 1, renewal_expires_at: now + 7200,
  });
  for (const kind of ['usage', 'sync', 'messages']) {
    const renewed = runScheduled(kind);
    assert.equal(renewed.value.ok, true);
    assert.ok(methods.includes('persistent_secret_put'));
  }
});

test('provider component requires configuration before remote stages', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  const result = runComponent({pluginInput: {configuration: {}, invocation: {action: 'status.get'}}});
  assert.equal(result.znet_plugin_result, 1);
  assert.equal(result.value.product_id, 'org.zerodenet.connect');
  assert.equal(result.value.phase, 'needs-configuration');
  assert.equal(result.value.checks[0].state, 'action_required');
});

test('provider component delegates interactive verification to the signed management page', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  const configuredSource = {id:'source-1', name:'My panel', origin:'https://panel.example.com', network_path:'direct'};
  const configuration = {provider_origins: JSON.stringify([configuredSource.origin])};
  const result = runComponent({pluginInput: {configuration, state:{'sources/index':JSON.stringify([configuredSource])}, invocation: {action: 'status.get'}}});
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
  const result = runComponent({pluginInput: {configuration, state, invocation: {action: 'status.get'}}});
  assert.equal(result.value.phase, 'ready');
  assert.equal(result.value.checks.find(item => item.id === 'subscription-binding').state, 'ready');
});

test('provider component exposes a persisted usage capability gap', async () => {
  const source = {id:'source-1', name:'Panel', origin:'https://panel.example.com', network_path:'direct'};
  const result = runComponent({pluginInput: {
    configuration: {provider_origins:'["https://panel.example.com"]'},
    state: {
      'sources/index': JSON.stringify([source]),
      'source/source-1/subscription/binding': JSON.stringify({remote_subscription_id:'subscription-1'}),
      'source/source-1/subscription/usage_error': JSON.stringify({message:'服务暂不提供用量'}),
    },
    invocation: {action:'status.get'},
  }});
  const usage = result.value.checks.find(item => item.id === 'subscription-usage');
  assert.equal(usage.state, 'action_required');
  assert.equal(usage.detail, '上次用量同步未成功：服务暂不提供用量');
});

test('provider component waits for a successful usage metadata update before reporting ready', () => {
  const source = {id:'source-1', name:'Panel', origin:'https://panel.example.com', network_path:'direct'};
  const state = {
    'sources/index': JSON.stringify([source]),
    'source/source-1/subscription/binding': JSON.stringify({remote_subscription_id:'subscription-1'}),
  };
  const pluginInput = {configuration: {provider_origins:'["https://panel.example.com"]'}, state, invocation: {action:'status.get'}};
  const before = runComponent({pluginInput});
  assert.equal(before.value.checks.find(item => item.id === 'subscription-usage').state, 'waiting');
  state['source/source-1/subscription/usage_checked_at'] = JSON.stringify(1800000000000);
  const after = runComponent({pluginInput});
  assert.equal(after.value.checks.find(item => item.id === 'subscription-usage').state, 'ready');
});

test('password authorization never returns or persists the submitted password', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  const secret = 'do-not-persist-this';
  const result = runComponent({pluginInput: {
    configuration: {provider_origins:'["https://panel.example.com"]'},
    state: {'sources/index':JSON.stringify([{id:'source-1', name:'Panel', origin:'https://panel.example.com', network_path:'direct'}])},
    invocation: {action: 'authorization.password', payload: {account: 'user@example.com', password: secret}},
  }});
  assert.equal(result.value.code, 'interactive_page_required');
  assert.deepEqual(Object.keys(result.state_updates), []);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
