export const PRODUCT_ID = 'org.zerodenet.zboard';
export const PACKAGE_ID = 'org.zerodenet.zboard';

const fields = [
  'pluginId',
  'sourceId',
  'accountId',
  'remoteSubscriptionId',
  'bindingVersion',
];

export function validateBinding(binding) {
  if (binding === null || typeof binding !== 'object') {
    throw new TypeError('binding must be an object');
  }
  for (const field of fields) {
    const value = binding[field];
    if ((field === 'bindingVersion' && (!Number.isSafeInteger(value) || value < 1)) ||
        (field !== 'bindingVersion' && (typeof value !== 'string' || value.trim() === ''))) {
      throw new TypeError(`invalid binding field: ${field}`);
    }
  }
  if (binding.pluginId !== PACKAGE_ID) {
    throw new TypeError('binding belongs to another plugin');
  }
  return binding;
}

export function bindingKey(binding) {
  validateBinding(binding);
  return fields.map((field) => {
    const value = String(binding[field]);
    return `${value.length}:${value}`;
  }).join('|');
}

export function canCommitFetch(result, current) {
  validateBinding(result.binding);
  validateBinding(current.binding);
  return !current.authorizationRevoked &&
    result.operationId === current.operationId &&
    result.authorizationEpoch === current.authorizationEpoch &&
    result.sourceRevision === current.sourceRevision &&
    bindingKey(result.binding) === bindingKey(current.binding);
}
