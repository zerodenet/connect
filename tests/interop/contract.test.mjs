import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PRODUCT_ID, PACKAGE_ID} from '../../znet-sink/src/binding.mjs';

const contract = JSON.parse(await readFile(new URL('../../protocol/v1/operations.json', import.meta.url)));
const registration = JSON.parse(await readFile(new URL('../../marketplace/product-registration.template.json', import.meta.url)));

test('both consumers share product and package identity', () => {
  assert.equal(contract.product_id, PRODUCT_ID);
  assert.equal(registration.id, PRODUCT_ID);
  assert.equal(contract.packages['znet-sink'], PACKAGE_ID);
  assert.deepEqual(
    Object.fromEntries(registration.targets.map((target) => [target.host, target.package_id])),
    contract.packages,
  );
});

test('operation and error identifiers are unique and explicit', () => {
  const operationIds = contract.operations.map((operation) => operation.id);
  assert.equal(new Set(operationIds).size, operationIds.length);
  assert.equal(new Set(contract.errors).size, contract.errors.length);
  assert.ok(operationIds.includes('authorization.renew'));
  assert.ok(operationIds.includes('subscriptions.get-content'));
  assert.ok(operationIds.includes('messages.get'));
});
