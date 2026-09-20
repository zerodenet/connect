(() => {
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

  // Scheduled actions run without a page. The host exposes only the same
  // typed, manifest-authorized SDK calls used by the signed management page.
  function scheduledSync(sourceId) {
    const updates = {};
    const nowUnixMs = Number(invocation.now_unix_ms);
    if (!Number.isFinite(nowUnixMs) || nowUnixMs <= 0) {
      return envelope({ok: false, retryable: true, message: 'Connect 后台执行时间无效。'});
    }
    const nowUnix = Math.floor(nowUnixMs / 1000);
    const fromBase64Url = (value) => unbase64(value.split('-').join('+').split('_').join('/') + '='.repeat((4 - value.length % 4) % 4));
    const base64Url = (bytes) => {
      let value = base64(bytes).split('+').join('-').split('/').join('_');
      while (value.endsWith('=')) value = value.slice(0, -1);
      return value;
    };
    const int64 = (value) => {
      const high = Math.floor(value / 0x100000000);
      const low = value >>> 0;
      return [
        (high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255,
        (low >>> 24) & 255, (low >>> 16) & 255, (low >>> 8) & 255, low & 255,
      ];
    };
    const transcript = (fields) => {
      const output = new Array(fields.reduce((size, field) => size + 4 + field.length, 0)).fill(0);
      let offset = 0;
      for (const field of fields) {
        const length = field.length;
        output[offset++] = (length >>> 24) & 255;
        output[offset++] = (length >>> 16) & 255;
        output[offset++] = (length >>> 8) & 255;
        output[offset++] = length & 255;
        for (const byte of field) output[offset++] = byte;
      }
      return output;
    };
    const sdk = (capability, scope, method, argumentsValue = {}, maxResultBytes = 8 * 1024 * 1024) => {
      const reply = JSON.parse(hostSdkCall(JSON.stringify({
        version: 1,
        request: {capability, scope},
        method,
        budget: {timeout_ms: 120000, max_result_bytes: maxResultBytes},
        arguments: argumentsValue,
      })));
      if (!reply.ok) {
        const error = new Error(reply.error?.message || 'Connect 后台宿主操作失败。');
        error.code = reply.error?.code;
        throw error;
      }
      return reply.value;
    };
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) return envelope({ok: true, skipped: true, reason: 'source_removed'});
    const sourceKey = (suffix) => sourceStateKey(source, suffix);
    const parseState = (suffix) => {
      const key = sourceKey(suffix);
      const raw = Object.prototype.hasOwnProperty.call(updates, key) ? updates[key] : state[key];
      return parseStoredValue(raw);
    };
    const setState = (suffix, value) => { updates[sourceKey(suffix)] = base64(utf8(JSON.stringify(value))); };
    const secretGet = (key) => {
      const result = sdk('secrets.persistent.read', 'self', 'persistent_secret_get', {key});
      return result ? decodeUtf8(unbase64(result.valueBase64)) : null;
    };
    const secretPut = (key, value) => sdk('secrets.persistent.write', 'self', 'persistent_secret_put', {
      key, valueBase64: base64(utf8(value)),
    });
    const secretDelete = (key) => sdk('secrets.persistent.write', 'self', 'persistent_secret_delete', {key});
    const digest = (bytes) => unbase64(sdk('crypto.device.use', 'self', 'crypto_digest', {dataBase64: base64(bytes)}).digestBase64);
    const identity = parseState('device/identity');
    const metadata = parseState('session/metadata');
    const binding = parseState('subscription/binding');
    if (!identity || !metadata || !binding?.remote_subscription_id) {
      return envelope({ok: true, skipped: true, reason: 'interactive_setup_required'}, updates);
    }
    const request = (path, options = {}) => {
      const origin = source.origin;
      const response = sdk('network.configured.request', 'provider_origins', 'configured_request', {
        url: `${origin}${path.startsWith('/') ? path : `/${path}`}`,
        method: options.method || 'GET',
        headers: options.headers || {},
        ...(options.body == null ? {} : {body: options.body}),
        route: source.network_path || 'direct',
      });
      let body;
      try { body = JSON.parse(response.body); }
      catch { throw new Error(`Connect 服务返回了无法识别的响应（HTTP ${response.status}）。`); }
      if (response.status < 200 || response.status >= 300) {
        const error = new Error(body.error || `Connect HTTP ${response.status}`);
        error.connectCode = body.error;
        throw error;
      }
      return body;
    };
    const capabilities = request('/.well-known/zerodenet-connect/v1/capabilities');
    const origin = source.origin;
    const required = ['authorization.password', 'authorization.renew', 'subscriptions.list', 'subscriptions.get-content', 'messages.list'];
    if (capabilities.protocol_version !== 1 || capabilities.provider_id !== origin ||
        capabilities.exchange_path !== '/.well-known/zerodenet-connect/v1/exchange' ||
        !Array.isArray(capabilities.operations) || required.some((operation) => !capabilities.operations.includes(operation))) {
      throw new Error('Connect 服务能力与已配置来源不匹配。');
    }
    const identityPublic = fromBase64Url(capabilities.identity_public_key);
    const statement = capabilities.provider_key_statement;
    const now = nowUnix;
    const fingerprint = base64Url(digest(identityPublic));
    const statementInput = transcript([
      utf8('zerodenet-connect/v1/provider-key'), utf8(statement.provider_id),
      utf8(statement.identity_key_id), utf8(statement.key_id), utf8(statement.hpke_public_key),
      int64(statement.not_before), int64(statement.not_after),
    ]);
    const verified = sdk('crypto.device.use', 'self', 'crypto_verify', {
      publicKeyBase64: base64(identityPublic), dataBase64: base64(statementInput),
      signatureBase64: base64(fromBase64Url(statement.signature)),
    });
    if (identityPublic.length !== 32 || fingerprint !== capabilities.identity_fingerprint ||
        statement.protocol_version !== 1 || statement.provider_id !== origin ||
        statement.identity_key_id !== capabilities.identity_key_id ||
        fromBase64Url(statement.hpke_public_key).length !== 32 ||
        statement.not_after <= statement.not_before || statement.not_after - statement.not_before > 90 * 86400 ||
        statement.not_before > now + 30 || statement.not_after < now - 30 || !verified.valid) {
      throw new Error('Connect 服务身份或通信密钥校验失败。');
    }
    const pinnedRaw = secretGet(sourceKey('trust/provider'));
    let pinned;
    try { pinned = JSON.parse(pinnedRaw); }
    catch { throw new Error('Connect 服务身份记录无效，请重新确认来源。'); }
    if (pinned?.provider_id !== origin || pinned?.identity_key_id !== capabilities.identity_key_id ||
        pinned?.identity_public_key !== capabilities.identity_public_key || pinned?.identity_fingerprint !== fingerprint) {
      throw new Error('Connect 服务身份不再匹配本机已确认记录。');
    }
    const deviceKeyName = source.device_key_name || `connect-device-${source.id}`;
    const deviceKey = sdk('crypto.device.use', 'self', 'crypto_key_generate', {keyName: deviceKeyName});
    const device = {...identity, public_key: base64Url(unbase64(deviceKey.publicKeyBase64))};
    let cachedAuthorization = null;
    const exchange = (operation, authorization, body) => {
      const responseKey = sdk('crypto.device.use', 'self', 'crypto_hpke_key_generate');
      const issuedAt = nowUnix;
      const requestId = base64Url(digest(transcript([unbase64(responseKey.publicKeyBase64), int64(issuedAt)])).slice(0, 16));
      const bodyRaw = JSON.stringify(body);
      const responsePublic = base64Url(unbase64(responseKey.publicKeyBase64));
      const proofInput = transcript([
        utf8('zerodenet-connect/v1/device-proof'), utf8(operation), utf8(requestId), int64(issuedAt), int64(issuedAt + 120),
        utf8(device.source_id), utf8(device.device_id), utf8(device.public_key), utf8(responsePublic),
        utf8(authorization.kind), digest(utf8(authorization.credential)), digest(utf8(bodyRaw)),
      ]);
      const signature = sdk('crypto.device.use', 'self', 'crypto_sign', {keyName: deviceKeyName, dataBase64: base64(proofInput)});
      const keyId = statement.key_id;
      const sealed = sdk('crypto.device.use', 'self', 'crypto_hpke_seal', {
        recipientPublicKeyBase64: base64(fromBase64Url(statement.hpke_public_key)),
        infoBase64: base64(utf8(`zerodenet-connect/v1/request/${keyId}`)),
        aadBase64: base64(utf8(`zerodenet-connect/v1/request\0${keyId}\0${requestId}`)),
        plaintextBase64: base64(utf8(JSON.stringify({
          protocol_version: 1, operation, request_id: requestId, issued_at: issuedAt, expires_at: issuedAt + 120,
          source_id: device.source_id, device_id: device.device_id, device_public_key: device.public_key,
          response_public_key: responsePublic, authorization, body,
          device_proof: base64Url(unbase64(signature.signatureBase64)),
        }))),
      });
      const responseEnvelope = request(capabilities.exchange_path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
        protocol_version: 1, suite: 'HPKE-0x0020-0x0001-0x0003', key_id: keyId, request_id: requestId,
        encapsulation: base64Url(unbase64(sealed.encapsulationBase64)), ciphertext: base64Url(unbase64(sealed.ciphertextBase64)),
      })});
      if (responseEnvelope.protocol_version !== 1 || responseEnvelope.suite !== 'HPKE-0x0020-0x0001-0x0003' ||
          responseEnvelope.key_id !== keyId || responseEnvelope.request_id !== requestId) throw new Error('Connect 响应关联校验失败。');
      const opened = sdk('crypto.device.use', 'self', 'crypto_hpke_open', {
        privateKeyHandle: responseKey.privateKeyHandle,
        senderPublicKeyBase64: base64(fromBase64Url(statement.hpke_public_key)),
        infoBase64: base64(utf8(`zerodenet-connect/v1/response/${keyId}`)),
        aadBase64: base64(utf8(`zerodenet-connect/v1/response\0${keyId}\0${requestId}`)),
        encapsulationBase64: base64(fromBase64Url(responseEnvelope.encapsulation)),
        ciphertextBase64: base64(fromBase64Url(responseEnvelope.ciphertext)),
      });
      const response = JSON.parse(decodeUtf8(unbase64(opened.plaintextBase64)));
      const responseNow = nowUnix;
      if (response.protocol_version !== 1 || response.operation !== operation || response.request_id !== requestId ||
          response.expires_at <= response.issued_at || response.expires_at - response.issued_at > 120 ||
          response.issued_at > responseNow + 30 || response.expires_at < responseNow - 30) throw new Error('Connect 响应消息无效或过期。');
      if (response.status === 'error') {
        const error = new Error(`Connect 请求失败：${response.error?.code || 'unknown'}`);
        error.connectCode = response.error?.code;
        throw error;
      }
      if (response.status !== 'ok' || response.body == null) throw new Error('Connect 响应缺少结果。');
      return response.body;
    };
    const authorization = () => {
      if (cachedAuthorization) return cachedAuthorization;
      const current = parseState('session/metadata');
      const currentTime = nowUnix;
      const access = secretGet(sourceKey('session/access'));
      if (access && current.access_expires_at > currentTime + 30) {
        cachedAuthorization = {kind: 'access', credential: access};
        return cachedAuthorization;
      }
      const renewal = secretGet(sourceKey('session/renewal'));
      if (!renewal || current.renewal_expires_at <= currentTime + 30) throw new Error('Connect 设备授权已过期，请重新登录。');
      const renewed = exchange('authorization.renew', {kind: 'renewal', credential: renewal}, {});
      secretPut(sourceKey('session/access'), renewed.access_credential);
      secretPut(sourceKey('session/renewal'), renewed.renewal_credential);
      setState('session/metadata', {
        user_id: renewed.user_id, device_id: renewed.device_id,
        access_expires_at: renewed.access_expires_at, renewal_expires_at: renewed.renewal_expires_at,
      });
      cachedAuthorization = {kind: 'access', credential: renewed.access_credential};
      return cachedAuthorization;
    };
    try {
      const projected = exchange('subscriptions.get-content', authorization(), {
        subscription_id: binding.remote_subscription_id, known_revision: binding.revision || null,
      });
      let changed = false;
      if (projected.not_modified !== true) {
        if (typeof projected.content !== 'string' || !projected.content) throw new Error('Connect 订阅内容为空。');
        const profile = sdk('subscriptions.manage', 'self', 'subscription_apply', {
          providerId: capabilities.provider_id, remoteSubscriptionId: binding.remote_subscription_id,
          sourceName: source.name, subscriptionName: projected.display_name || binding.name,
          content: projected.content, format: projected.format, revision: projected.revision,
        });
        setState('subscription/binding', {id: profile.id, name: profile.name, remote_subscription_id: binding.remote_subscription_id, revision: projected.revision});
        changed = true;
      }
      const page = exchange('messages.list', authorization(), {cursor: null, limit: 20});
      const items = Array.isArray(page.messages) ? page.messages : [];
      const previous = parseState('messages/summary');
      const priorUnread = (previous?.items || []).filter((message) => message.read_at == null).map((message) => message.message_id);
      const unread = items.filter((message) => message.read_at == null);
      const fresh = unread.filter((message) => !priorUnread.includes(message.message_id));
      if (fresh.length) sdk('notifications.post', 'self', 'notification_post', {
        kind: 'info', message: `Connect 有 ${fresh.length} 条新消息`, duration_ms: 5000,
        action: {pageId: 'manage', route: `messages.${source.id}`, reference: fresh[0]?.message_id},
      }, 65536);
      setState('messages/summary', {checked_at: nowUnixMs, unread: unread.length, items});
      return envelope({ok: true, changed, unread: unread.length}, updates);
    } catch (error) {
      if (['communication_disabled', 'reauthorization_required', 'authorization_revoked', 'replay_rejected', 'unauthorized'].includes(error.connectCode)) {
        secretDelete(sourceKey('session/access'));
        secretDelete(sourceKey('session/renewal'));
        updates[sourceKey('session/metadata')] = null;
        sdk('notifications.post', 'self', 'notification_post', {
          kind: 'warning', message: 'Connect 授权已失效，请重新登录。', duration_ms: 8000,
          action: {pageId: 'manage', route: `authorization.${source.id}`},
        }, 65536);
      }
      return envelope({ok: false, retryable: !error.connectCode, message: error.message || 'Connect 后台同步失败。'}, updates);
    }
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
      'device/identity', 'session/metadata', 'subscription/binding', 'messages/summary',
    ].map((suffix) => [sourceStateKey(source, suffix), null])));
  }
  if (invocation.action === 'lifecycle.host_start') {
    return envelope({
      restored: hasSession || hasBinding,
      reason: hasBinding ? 'ready' : hasSession ? 'subscription_required' : configured ? 'interactive_setup_required' : 'source_not_configured',
    });
  }
  if (invocation.action.startsWith('lifecycle.scheduled.sync.')) {
    return scheduledSync(invocation.action.slice('lifecycle.scheduled.sync.'.length));
  }
  return envelope({ok: false, code: 'unsupported_action', message: '当前 Connect 版本不支持此操作。'});
})()
