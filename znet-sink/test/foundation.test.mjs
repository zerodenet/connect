import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('foundation component is inert and reports unavailable business capabilities', async () => {
  const source = await readFile(new URL('../src/foundation.mjs', import.meta.url), 'utf8');
  const result = vm.runInNewContext(source, Object.create(null), {timeout: 100});
  assert.equal(result.product_id, 'org.zerodenet.connect');
  assert.equal(result.status, 'foundation');
  assert.deepEqual(Array.from(result.unavailable), ['authorization', 'subscription-sync', 'messages']);
});
