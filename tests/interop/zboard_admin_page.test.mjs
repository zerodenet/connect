import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../zboard/ui/admin/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(script, 'admin page script is present');

class Element {
  constructor() {
    this.checked = false;
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.classList = {toggle: (name, enabled) => {
      const values = new Set(this.className.split(/\s+/).filter(Boolean));
      enabled ? values.add(name) : values.delete(name);
      this.className = [...values].join(' ');
    }};
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type) {
    return this.listeners.get(type)?.({preventDefault() {}});
  }
}

function createPage(initialView = {configured: false, revision: 0, config: {}}) {
  const ids = [
    'capabilities-url', 'display-name', 'enabled', 'exchange-url', 'next-step',
    'notice', 'notice-detail', 'notice-title', 'progress', 'provider-id', 'save',
    'settings', 'status', 'test',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const listeners = new Map();
  let view = structuredClone(initialView);
  const calls = [];
  const parent = {
    postMessage(message) {
      calls.push(message);
      if (!message.request_id || message.type === 'plugin.ready') return;
      let result;
      if (message.type === 'context.load') result = {};
      if (message.type === 'config.load') result = structuredClone(view);
      if (message.type === 'config.save') {
        view = {configured: true, revision: message.revision + 1, config: structuredClone(message.config)};
        result = structuredClone(view);
      }
      if (message.type === 'config.test') result = {healthy: true};
      listeners.get('message')?.({
        source: parent,
        data: {
          source: 'zboard-plugin-host',
          bridge_token: 'bridge',
          request_id: message.request_id,
          ok: true,
          result,
        },
      });
    },
  };
  const sandbox = {
    Error,
    Map,
    Promise,
    URL,
    URLSearchParams,
    addEventListener(type, listener) { listeners.set(type, listener); },
    document: {
      documentElement: {scrollHeight: 640},
      getElementById(id) { return elements[id]; },
    },
    location: {
      hash: '#bridge_token=bridge',
      href: 'https://zboard.example/api/v1/plugin-assets/session/ui/admin/index.html#bridge_token=bridge',
    },
    parent,
    requestAnimationFrame(callback) { callback(); },
    structuredClone,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox, {filename: 'zboard/ui/admin/index.html'});
  return {calls, elements, getView: () => structuredClone(view)};
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

test('ZBoard admin page defaults to the current site and confirms persisted enabled configuration', async () => {
  const page = createPage();
  await settle();

  assert.equal(page.elements['provider-id'].value, 'https://zboard.example');
  assert.equal(page.elements.status.textContent, '未配置');
  assert.equal(page.elements.test.disabled, true);

  page.elements.enabled.checked = true;
  page.elements.enabled.dispatch('change');
  assert.equal(page.elements.status.textContent, '有未保存更改');
  await page.elements.settings.dispatch('submit');
  await settle();

  assert.deepEqual(page.getView().config, {
    enabled: true,
    provider_id: 'https://zboard.example',
    display_name: 'ZBoard',
  });
  assert.equal(page.elements.status.textContent, '已启用');
  assert.equal(page.elements['notice-title'].textContent, '设置已保存并启用');
  assert.match(page.elements['notice-detail'].textContent, /下一步/);
  assert.equal(page.elements.test.disabled, false);

  const reopened = createPage(page.getView());
  await settle();
  assert.equal(reopened.elements.enabled.checked, true);
  assert.equal(reopened.elements['provider-id'].value, 'https://zboard.example');
  assert.equal(reopened.elements.status.textContent, '已启用');
});
