import {scheduledSync} from './background.mjs';

export default function connectComponent() {
  const input = globalThis.pluginInput ?? {};
  const configuration = input.configuration ?? {};
  const state = input.state ?? {};
  const invocation = input.invocation ?? {action: 'status.get', payload: null};
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const utf8 = (value) => {
    const output = [];
    for (const character of value) {
      const point = character.codePointAt(0);
      if (point < 0x80) output.push(point);
      else if (point < 0x800) output.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
      else if (point < 0x10000) output.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
      else output.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    }
    return output;
  };
  const decodeUtf8 = (bytes) => {
    let output = '';
    for (let index = 0; index < bytes.length;) {
      const first = bytes[index++];
      let point;
      if (first < 0x80) point = first;
      else if (first < 0xe0) point = ((first & 0x1f) << 6) | (bytes[index++] & 0x3f);
      else if (first < 0xf0) point = ((first & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
      else {
        point = ((first & 0x07) << 18) | ((bytes[index++] & 0x3f) << 12) |
          ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
      }
      output += String.fromCodePoint(point);
    }
    return output;
  };
  const base64 = (bytes) => {
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const a = bytes[index];
      const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
      output += alphabet[a >> 2];
      output += alphabet[((a & 3) << 4) | (b >> 4)];
      output += index + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
      output += index + 2 < bytes.length ? alphabet[c & 63] : '=';
    }
    return output;
  };
  const unbase64 = (value) => {
    let clean = '';
    for (const character of value) {
      if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') clean += character;
    }
    const length = clean.length - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
    const output = new Array(Math.floor(length * 6 / 8)).fill(0);
    let buffer = 0;
    let bits = 0;
    let offset = 0;
    for (let index = 0; index < clean.length && clean[index] !== '='; index += 1) {
      const digit = alphabet.indexOf(clean[index]);
      if (digit < 0) throw new Error('Connect Base64 数据无效。');
      buffer = (buffer << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output[offset++] = (buffer >> bits) & 255;
      }
    }
    return output;
  };
  const parseStoredValue = (raw) => {
    if (typeof raw !== 'string') return null;
    let value;
    try { value = JSON.parse(raw); }
    catch { value = JSON.parse(decodeUtf8(unbase64(raw))); }
    if (typeof value === 'string') value = JSON.parse(value);
    return value;
  };
  const parseStored = (key) => parseStoredValue(state[key]);
  const sources = parseStored('sources/index') || [];
  const configured = Array.isArray(sources) && sources.length > 0;
  const sourceStateKey = (source, suffix) => `source/${source.id}/${suffix}`;
  const hasSession = sources.some((source) => typeof state[sourceStateKey(source, 'session/metadata')] === 'string');
  const hasBinding = sources.some((source) => typeof state[sourceStateKey(source, 'subscription/binding')] === 'string');
  const hasMessages = sources.some((source) => typeof state[sourceStateKey(source, 'messages/summary')] === 'string');
  const usageError = sources.map((source) => parseStored(sourceStateKey(source, 'subscription/usage_error')))
    .find((value) => typeof value?.message === 'string');
  const hasUsageSync = sources.some((source) => Number.isSafeInteger(parseStored(sourceStateKey(source, 'subscription/usage_checked_at'))));

  function status() {
    const checks = [
      {
        id: 'source-configuration',
        label: '来源配置',
        state: configured ? 'ready' : 'action_required',
        detail: configured ? `已配置 ${sources.length} 个来源。` : '请先保存来源名称、HTTPS 服务地址和通信路径。',
      },
      {
        id: 'provider-capability',
        label: '远端 Connect 服务',
        state: hasSession ? 'ready' : configured ? 'action_required' : 'waiting',
        detail: hasSession ? '服务身份已经过交互验证。' : configured ? '请在 Connect 管理页主动验证服务身份。' : '保存来源配置后检查。',
      },
      {id: 'service-identity', label: '服务身份与设备密钥', state: hasSession ? 'ready' : 'waiting', detail: hasSession ? '本机设备身份已建立。' : '在管理页确认服务后建立。'},
      {id: 'account-authorization', label: '账号授权', state: hasSession ? 'ready' : 'waiting', detail: hasSession ? '当前设备已有授权记录。' : '密码仅用于一次授权，不写入普通配置或插件状态。'},
      {id: 'subscription-binding', label: '订阅关联', state: hasBinding ? 'ready' : 'waiting', detail: hasBinding ? '已关联客户端托管订阅。' : '授权后选择订阅。'},
      ...(hasBinding ? [{id: 'subscription-usage', label: '流量与到期时间',
        state: usageError ? 'action_required' : hasUsageSync ? 'ready' : 'waiting',
        detail: usageError?.message ? `上次用量同步未成功：${usageError.message}` : (hasUsageSync ? '最近一次用量已写入客户端。' : '等待首次用量同步。')}] : []),
      {id: 'messages', label: '消息', state: hasMessages ? 'ready' : hasSession ? 'action_required' : 'waiting', detail: hasMessages ? '已有最近一次消息同步记录。' : hasSession ? '请在管理页同步消息。' : '授权后可用。'},
    ];
    return {
      schema_version: 1,
      product_id: 'org.zerodenet.connect',
      adapter: 'znet-sink',
      phase: hasBinding ? 'ready' : hasSession ? 'needs-subscription' : configured ? 'needs-interactive-setup' : 'needs-configuration',
      sources: sources.map((source) => ({id: source.id, name: source.name, origin: source.origin, network_path: source.network_path})),
      checks,
      capability_gap: null,
    };
  }

  function envelope(value, stateUpdates = {}) {
    return {znet_plugin_result: 1, state_updates: stateUpdates, value};
  }

  if (invocation.action === 'status.get' || invocation.action === 'diagnostics.run') {
    return envelope(status());
  }
  if (invocation.action === 'authorization.password') {
    const payload = invocation.payload ?? {};
    if (!configured) {
      return envelope({ok: false, code: 'source_not_configured', message: '请先保存来源配置。'});
    }
    if (typeof payload.account !== 'string' || payload.account.trim() === '' ||
        typeof payload.password !== 'string' || payload.password === '') {
      return envelope({ok: false, code: 'invalid_credentials_input', message: '请输入账号和密码。'});
    }
    return envelope({ok: false, code: 'interactive_page_required', message: '请在 Connect 管理页完成设备授权；密码未保存。'});
  }
  if (invocation.action === 'source.reset') {
    const source = sources.find((candidate) => candidate.id === invocation.payload?.source_id);
    if (!source) return envelope({ok: false, code: 'source_not_found', message: '来源不存在。'});
    return envelope({ok: true, status: status()}, Object.fromEntries([
      'device/identity', 'session/metadata', 'subscription/binding', 'subscription/usage_error',
      'subscription/usage_checked_at', 'messages/summary',
    ].map((suffix) => [sourceStateKey(source, suffix), null])));
  }
  if (invocation.action === 'lifecycle.host_start') {
    return envelope({
      restored: hasSession || hasBinding,
      reason: hasBinding ? 'ready' : hasSession ? 'subscription_required' : configured ? 'interactive_setup_required' : 'source_not_configured',
    });
  }
  const scheduledActions = [
    ['lifecycle.scheduled.sync.', 'subscription'],
    ['lifecycle.scheduled.usage.', 'usage'],
    ['lifecycle.scheduled.messages.', 'messages'],
  ];
  const scheduledAction = scheduledActions.find(([prefix]) => invocation.action.startsWith(prefix));
  if (scheduledAction) {
    const [prefix, kind] = scheduledAction;
    return scheduledSync(invocation.action.slice(prefix.length), kind, {
      sources, state, invocation, sourceStateKey, parseStoredValue, envelope,
      base64, utf8, unbase64, decodeUtf8, hostSdkCall: globalThis.hostSdkCall,
    });
  }
  return envelope({ok: false, code: 'unsupported_action', message: '当前 Connect 版本不支持此操作。'});
}
