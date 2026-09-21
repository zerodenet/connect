import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html = await readFile(new URL('../ui/management.html', import.meta.url), 'utf8');

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
  assert.ok(html.includes("network_path: networkPath"));
  assert.ok(html.includes("znetPlugin.configuration.save"));
  assert.ok(html.includes("znetPlugin.capabilities.call"));
  assert.ok(html.includes("network.configured.request"));
  assert.ok(html.includes("crypto_hpke_seal"));
  assert.ok(html.includes("subscription_apply"));
  assert.ok(html.includes("authorization.password"));
  assert.ok(html.includes("messages.get"));
  assert.ok(html.includes("messages.mark-read"));
  assert.ok(html.includes("requiredOperations"));
  assert.ok(html.includes("90 * 24 * 60 * 60"));
  assert.ok(html.includes("response.expires_at - response.issued_at > 120"));
  assert.ok(html.includes('taskId: sourceTaskId(activeSource)'));
  assert.ok(html.includes("intervalSeconds: 900"));
  assert.ok(html.includes("znetPlugin.navigation?.initial?.()"));
  assert.ok(html.includes("route: `messages.${activeSource.id}`"));
  assert.ok(html.includes("'subscription_remove'"));
  assert.ok(html.includes("statePut('sources/index'"));
  assert.ok(html.includes("code === 'communication_disabled'"));
  assert.ok(html.includes('来源已保存，但 ZBoard 尚未启用 Connect'));
  assert.ok(html.includes("code === 'permission_denied'"));
  assert.ok(html.includes('打开上方“权限”页'));
  assert.ok(html.includes('id="backServiceSources"'));
  assert.ok(html.includes("actions.setAttribute('data-znet-actions', '')"));
  assert.ok(html.includes("open.setAttribute('data-variant', 'outline')"));
  assert.ok(html.includes("open.textContent = '管理来源'"));
});

test('management page does not poll, bypass the host, or persist account secrets', () => {
  assert.equal(/setInterval|requestAnimationFrame/.test(html), false);
  assert.equal(/\bfetch\s*\(/.test(html), false);
  assert.equal(/XMLHttpRequest|WebSocket|localStorage|sessionStorage/.test(html), false);
  assert.ok(html.includes("byId('password').value = ''"));
  assert.equal(/storage\.(?:put|putJson)\([^)]*password/i.test(html), false);
});
