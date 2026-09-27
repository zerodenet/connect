export function scheduledSync(sourceId, kind, context) {
  const {sources, state, invocation, sourceStateKey, parseStoredValue, envelope, base64, utf8, unbase64, decodeUtf8, hostSdkCall} = context;
  // A host-owned scheduled invocation runs without a page and uses only the
  // same declared, authorized SDK bridge as the interactive component.
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
    const log = (level, message, fields = {}) => {
      try {
        const safeFields = {...fields};
        if (safeFields.code && (typeof safeFields.code !== 'string' || safeFields.code.length > 64 ||
          ![...safeFields.code].every(character =>
            (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character === '_'))) {
          safeFields.code = 'unclassified';
        }
        sdk('plugin.logs.write', 'self', 'log_write', {
          level, message, fields: {task: kind, sourceId, ...safeFields},
        }, 4096);
      } catch { /* A log write must not change the scheduled task result. */ }
    };
    const notify = (argumentsValue) => {
      try {
        sdk('notifications.post', 'self', 'notification_post', argumentsValue, 65536);
      } catch (error) {
        // Notification permission or OS delivery must not roll back message
        // state, subscription work, or authorization cleanup.
        log('warn', 'Connect 后台通知未送达', {code: error?.code || 'notification_failed'});
      }
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
    const appliedRevision = parseState('subscription/applied_revision');
    if (!identity || !metadata || (kind !== 'messages' && !binding?.remote_subscription_id)) {
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
    const refreshUsage = () => {
      if (!capabilities.operations.includes('subscriptions.usage')) {
        setState('subscription/usage_error', {
          message: '此服务尚未开放订阅用量能力，客户端暂时无法显示流量和到期时间。请在服务端启用通用订阅用量能力后重试。',
          checked_at: nowUnixMs,
        });
        log('warn', 'Connect 后台用量同步缺少服务能力', {reason: 'provider_capability_unavailable'});
        return false;
      }
      try {
        const usage = exchange('subscriptions.usage', authorization(), {
          subscription_id: binding.remote_subscription_id,
        });
        const valid = usage.subscription_id === binding.remote_subscription_id &&
          ['used_bytes', 'total_bytes', 'expire_at_unix_ms'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0) &&
          usage.total_bytes > 0 && usage.expire_at_unix_ms > 0;
        if (!valid) throw new Error('Connect 服务返回的订阅用量信息无效。');
        sdk('subscriptions.manage', 'self', 'subscription_metadata_update', {
          providerId: capabilities.provider_id, remoteSubscriptionId: binding.remote_subscription_id,
          usage: {usedBytes: usage.used_bytes, totalBytes: usage.total_bytes, expireAtUnixMs: usage.expire_at_unix_ms},
        });
        setState('subscription/usage_checked_at', nowUnixMs);
        setState('subscription/usage_error', null);
        return true;
      } catch (error) {
        const message = error?.message === '插件宿主操作失败'
          ? '当前客户端未提供托管订阅用量写入能力；请升级到包含 subscription_metadata_update 的版本。'
          : error?.message || 'Connect 订阅用量更新失败。';
        setState('subscription/usage_error', {message, checked_at: nowUnixMs});
        log('warn', 'Connect 后台用量同步失败', {code: error?.connectCode || error?.code || 'usage_update_failed'});
        return false;
      }
    };
    try {
      if (kind === 'subscription') {
        // Upgrade old installations through their existing sync task; usage
        // and messages must keep running even if content cannot be projected.
        const intervalSeconds = source.sync_interval_seconds ?? 900;
        if (intervalSeconds > 0) {
          const tasks = sdk('tasks.schedule', 'self', 'schedule_list', {}, 65536);
          for (const name of ['usage', 'messages']) {
            const taskId = `connect-${name}-${source.id}`;
            if (!tasks.some(task => task.taskId === taskId)) {
              sdk('tasks.schedule', 'self', 'schedule_put', {
                taskId, action: `${name}.${source.id}`, intervalSeconds,
              }, 65536);
            }
          }
        }
      }
      if (kind === 'usage') {
        const updated = refreshUsage();
        if (updated) log('info', 'Connect 后台用量同步完成');
        return envelope({
          ok: true, updated,
          ...(!capabilities.operations.includes('subscriptions.usage') ? {reason: 'provider_capability_unavailable'} : {}),
        }, updates);
      }
      if (kind === 'subscription') {
        const knownRevision = appliedRevision?.remote_subscription_id === binding.remote_subscription_id &&
          appliedRevision?.revision === binding.revision
          ? appliedRevision.revision : null;
        const projected = exchange('subscriptions.get-content', authorization(), {
          subscription_id: binding.remote_subscription_id, known_revision: knownRevision,
        });
        let changed = false;
        let usageUpdated = null;
        if (projected.not_modified !== true) {
          if (typeof projected.content !== 'string' || !projected.content) throw new Error('Connect 订阅内容为空。');
          let content = projected.content;
          if (projected.format === 'znet-sink' && content.trimStart().startsWith('{')) {
            try { JSON.parse(content); }
            catch { throw new Error('Connect 服务返回的 ZNet Sink 订阅不是有效 JSON。'); }
            content = base64(utf8(content));
          }
          const profile = sdk('subscriptions.manage', 'self', 'subscription_apply', {
            providerId: capabilities.provider_id, remoteSubscriptionId: binding.remote_subscription_id,
            sourceName: source.name, subscriptionName: projected.display_name || binding.name,
            content, format: projected.format, revision: projected.revision,
          });
          setState('subscription/binding', {id: profile.id, name: profile.name, remote_subscription_id: binding.remote_subscription_id, revision: projected.revision});
          setState('subscription/applied_revision', {
            remote_subscription_id: binding.remote_subscription_id,
            revision: projected.revision,
          });
          // subscription_apply replaces quota metadata in the host. Restore it
          // immediately, even when the separate usage task ran first.
          usageUpdated = refreshUsage();
          changed = true;
        }
        if (changed) log(usageUpdated ? 'info' : 'warn', 'Connect 后台订阅同步完成', {usageUpdated});
        return envelope({ok: true, changed}, updates);
      }
      if (kind !== 'messages') throw new Error('Connect 后台任务类型无效。');
      const page = exchange('messages.list', authorization(), {cursor: null, limit: 20});
      const items = Array.isArray(page.messages) ? page.messages : [];
      const previous = parseState('messages/summary');
      const priorUnread = (previous?.items || []).filter((message) => message.read_at == null).map((message) => message.message_id);
      const unread = items.filter((message) => message.read_at == null);
      const fresh = unread.filter((message) => !priorUnread.includes(message.message_id));
      if (fresh.length) notify({
        kind: 'info', message: `Connect 有 ${fresh.length} 条新消息`, duration_ms: 5000,
        action: {pageId: 'manage', route: `messages.${source.id}`, reference: fresh[0]?.message_id},
      });
      setState('messages/summary', {checked_at: nowUnixMs, unread: unread.length, items});
      if (fresh.length) log('info', 'Connect 后台发现新消息', {newCount: fresh.length});
      return envelope({ok: true, unread: unread.length}, updates);
    } catch (error) {
      if (['communication_disabled', 'reauthorization_required', 'authorization_revoked', 'replay_rejected', 'unauthorized'].includes(error.connectCode)) {
        secretDelete(sourceKey('session/access'));
        secretDelete(sourceKey('session/renewal'));
        updates[sourceKey('session/metadata')] = null;
        notify({
          kind: 'warning', message: 'Connect 授权已失效，请重新登录。', duration_ms: 8000,
          action: {pageId: 'manage', route: `authorization.${source.id}`},
        });
      }
      log('error', 'Connect 后台同步失败', {code: error?.connectCode || error?.code || 'task_failed'});
      return envelope({ok: false, retryable: !error.connectCode, message: error.message || 'Connect 后台同步失败。'}, updates);
    }
  }
