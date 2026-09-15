import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_ID, bindingKey, canCommitFetch } from '../src/binding.mjs';

const binding = Object.freeze({
  pluginId: PACKAGE_ID,
  sourceId: 'source-a',
  accountId: 'account-a',
  remoteSubscriptionId: 'subscription-a',
  bindingVersion: 1,
});

test('the same managed source selection has one stable identity', () => {
  assert.equal(bindingKey(binding), bindingKey({...binding}));
  assert.notEqual(bindingKey(binding), bindingKey({...binding, remoteSubscriptionId: 'subscription-b'}));
});

test('late results cannot cross authorization, source revision, operation, or binding', () => {
  const current = {binding, operationId: 'op-1', authorizationEpoch: 8, sourceRevision: 4, authorizationRevoked: false};
  assert.equal(canCommitFetch({...current}, current), true);
  assert.equal(canCommitFetch({...current, operationId: 'op-0'}, current), false);
  assert.equal(canCommitFetch({...current, authorizationEpoch: 7}, current), false);
  assert.equal(canCommitFetch({...current, sourceRevision: 3}, current), false);
  assert.equal(canCommitFetch({...current, binding: {...binding, accountId: 'account-b'}}, current), false);
  assert.equal(canCommitFetch({...current}, {...current, authorizationRevoked: true}), false);
});

test('a URL-style or foreign-plugin binding is rejected', () => {
  assert.throws(() => bindingKey({...binding, pluginId: 'org.example.other'}), /another plugin/);
  assert.throws(() => bindingKey({...binding, remoteSubscriptionId: ''}), /remoteSubscriptionId/);
});
