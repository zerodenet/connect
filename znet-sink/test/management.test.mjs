import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html = await readFile(new URL('../ui/management.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../ui/page.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../ui/style.css', import.meta.url), 'utf8');

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
