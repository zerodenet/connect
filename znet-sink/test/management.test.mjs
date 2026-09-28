import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const html = await readFile(new URL('../ui/management.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../ui/page.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../ui/style.css', import.meta.url), 'utf8');

const usageMessageDeclaration = script.split('\n').find(line => line.includes('const usageUnavailableMessage ='));
const unavailableMessage = runInNewContext(`${usageMessageDeclaration}\nusageUnavailableMessage`);
const statusFunction = script.slice(script.indexOf('      async function currentStatus()'), script.indexOf('      async function invoke('));

async function diagnoseUsage({operations, error = null, checkedAt = null}) {
  const stored = {
    'session/metadata': {user_id:'user-1'},
    'subscription/binding': {remote_subscription_id:'1', name:'Example plan'},
    'subscription/usage_error': error,
    'subscription/usage_checked_at': checkedAt,
  };
  const before = structuredClone(stored);
  const context = {
    activeSource: {name:'Example', origin:'https://panel.example.com', network_path:'core'},
    providerCapabilities: {operations:[]},
    sourceStateGet: async key => stored[key],
    loadCapabilities: async () => { context.providerCapabilities = {operations}; },
  };
  const status = await runInNewContext(`${usageMessageDeclaration}\n${statusFunction}\ncurrentStatus()`, context);
  assert.deepEqual(stored, before, 'diagnosis must not rewrite subscription state');
  return status;
}

test('diagnosis recognizes restored provider usage support without claiming a new usage sync', async () => {
  const status = await diagnoseUsage({
    operations:['subscriptions.usage'], error:{message:unavailableMessage}, checkedAt:1800000000000,
  });
  const usage = status.checks.find(check => check.id === 'subscription-usage');
  assert.equal(usage.state, 'waiting');
  assert.match(usage.detail, /服务已开放.*立即同步/);
  assert.equal(status.checks.find(check => check.id === 'subscription-binding').detail, 'Example plan');
  assert.equal(status.capability_gap, null);
});

test('diagnosis keeps current missing support and genuine usage failures actionable', async () => {
  for (const [operations, error, message] of [
    [[], null, unavailableMessage],
    [['subscriptions.usage'], {message:'订阅用量写入失败'}, '订阅用量写入失败'],
  ]) {
    const status = await diagnoseUsage({operations, error});
    const usage = status.checks.find(check => check.id === 'subscription-usage');
    assert.equal(usage.state, 'action_required');
    assert.equal(usage.detail, message);
  }
});

test('diagnosis reports ready only after successful metadata synchronization', async () => {
  for (const checkedAt of [null, 1800000000000]) {
    const status = await diagnoseUsage({operations:['subscriptions.usage'], checkedAt});
    assert.equal(status.checks.find(check => check.id === 'subscription-usage').state, checkedAt ? 'ready' : 'waiting');
  }
});

test('management page follows the host settings standard and exposes a progressive workflow', () => {
  for (const marker of ['添加来源', '保存并检查', '确认服务', '授权此设备', '选择订阅', '立即同步', '服务消息', '移除来源', '技术诊断']) {
    assert.ok(html.includes(marker), `missing ${marker}`);
  }
  for (const marker of ['data-znet-layout="settings"', 'data-znet-panel', 'view-source', 'view-service', 'view-account']) {
    assert.ok(html.includes(marker), `missing host UI marker ${marker}`);
  }
  assert.equal(html.includes('data-znet-settings-nav'), false);
  assert.equal(html.includes('Host API 尚未'), false);
  assert.equal(html.includes('<style>'), false);
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(html), false);
  assert.equal(html.includes('<select'), false);
  assert.ok(html.includes('data-znet-select-trigger'));
  assert.ok(html.includes('role="listbox"'));
  assert.ok(html.includes('role="option"'));
  assert.ok(script.includes("network_path: networkPath"));
  assert.ok(script.includes("znetPlugin.configuration.save"));
  assert.ok(script.includes("znetPlugin.capabilities.call"));
  assert.ok(script.includes("network.configured.request"));
  assert.ok(script.includes("crypto_hpke_seal"));
  assert.ok(script.includes("subscription_apply"));
  assert.ok(script.includes("subscription_metadata_update"));
  assert.ok(script.includes("authorization.password"));
  assert.ok(script.includes("messages.get"));
  assert.ok(script.includes("messages.mark-read"));
  assert.ok(script.includes("requiredOperations"));
  assert.ok(script.includes("90 * 24 * 60 * 60"));
  assert.ok(script.includes("response.expires_at - response.issued_at > 120"));
  assert.ok(script.includes('sourceTasks(activeSource)'));
  assert.ok(script.includes('connect-usage-${source.id}'));
  assert.ok(script.includes('connect-messages-${source.id}'));
  assert.ok(script.includes("'schedule_list'"));
  assert.ok(script.includes('sync_interval_seconds: syncIntervalSeconds'));
  assert.ok(script.includes("znetPlugin.navigation?.initial?.()"));
  assert.ok(script.includes("route: `messages.${activeSource.id}`"));
  assert.ok(script.includes("'subscription_remove'"));
  assert.ok(script.includes("statePut('sources/index'"));
  assert.ok(script.includes("code === 'communication_disabled'"));
  assert.ok(script.includes('来源已保存，但 ZBoard 尚未启用 Connect'));
  assert.ok(script.includes("code === 'permission_denied'"));
  assert.ok(script.includes('打开上方“权限”页'));
  assert.ok(html.includes('id="backServiceSources"'));
  assert.ok(script.includes("actions.setAttribute('data-znet-actions', '')"));
  assert.ok(script.includes("open.setAttribute('data-variant', 'outline')"));
  assert.ok(script.includes("open.textContent = '管理来源'"));
  assert.ok(html.includes('id="messageDialog"'));
  assert.ok(html.includes('id="syncIntervals"'));
  assert.ok(script.includes('removeSourceRecord(source)'));
  assert.ok(style.includes('var(--card)'));
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(style), false);
});

test('management page does not poll, bypass the host, or persist account secrets', () => {
  assert.equal(/setInterval|requestAnimationFrame/.test(script), false);
  assert.equal(/\bfetch\s*\(/.test(script), false);
  assert.equal(/XMLHttpRequest|WebSocket|localStorage|sessionStorage/.test(script), false);
  assert.ok(script.includes("byId('password').value = ''"));
  assert.equal(/storage\.(?:put|putJson)\([^)]*password/i.test(script), false);
});

const pullFunction = script.slice(script.indexOf('      async function pullSubscription('), script.indexOf('      async function removePendingSubscription('));

test('unchanged manual content check records sync success only for the applied revision', async () => {
  for (const returnedRevision of ['rev-2', 'wrong-revision']) {
    const calls = [];
    const context = {
      accessAuthorization: async () => ({type:'device'}),
      sourceStateGet: async key => key.endsWith('binding')
        ? {remote_subscription_id:'1', revision:'rev-2'}
        : {remote_subscription_id:'1', revision:'rev-2'},
      refreshSubscriptionUsage: async () => 'quota refresh failed',
      exchange: async () => ({not_modified:true, revision:returnedRevision}),
      providerCapabilities: {provider_id:'https://panel.example.com'},
      sdk: async (...args) => calls.push(args),
    };
    const result = runInNewContext(`${pullFunction}\npullSubscription('1', 'Plan')`, context);
    if (returnedRevision === 'rev-2') {
      const value = await result;
      assert.equal(value.notModified, true);
      assert.equal(value.usageError, 'quota refresh failed');
      assert.equal(calls.length, 1);
      assert.equal(calls[0][2], 'subscription_sync_complete');
      assert.equal(calls[0][3].revision, 'rev-2');
    } else {
      await assert.rejects(result, /未变化版本/);
      assert.equal(calls.length, 0);
    }
  }
});
