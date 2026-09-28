    (() => {
      const component = 'provider-source';
      const initialNavigation = znetPlugin.navigation?.initial?.() || null;
      const views = ['sources', 'source', 'service', 'account', 'subscriptions', 'complete', 'diagnostics'];
      const headings = {
        sources: ['Connect 来源', '添加或管理多个彼此隔离的 ZBoard 来源。'],
        source: ['连接订阅来源', '第 1 步，共 3 步 · 添加一个兼容的服务地址。'],
        service: ['确认服务', '第 1 步，共 3 步 · 确认服务支持 Connect。'],
        account: ['授权设备', '第 2 步，共 3 步 · 使用账号授权当前设备。'],
        subscriptions: ['选择订阅', '第 3 步，共 3 步 · 选择要由客户端托管的订阅。'],
        complete: ['Connect 已连接', '此来源已经可以在客户端中使用。'],
        diagnostics: ['技术诊断', '排查连接问题，不会修改现有设置。'],
      };
      const byId = id => document.getElementById(id);
      let latest = null;
      let currentView = 'sources';
      let diagnosticsReturnView = 'sources';
      let requestInFlight = false;
      let activeAction = null;
      let statusGeneration = 0;
      let networkPath = 'direct';
      let syncIntervalSeconds = 900;
      let providerCapabilities = null;
      const usageUnavailableMessage = '此服务尚未开放订阅用量能力，客户端暂时无法显示流量和到期时间。请在服务端启用通用订阅用量能力后重试。';
      let availableSubscriptions = [];
      let selectedSubscriptionId = null;
      let messageItems = [];
      let sources = [];
      let activeSource = null;

      const networkPathOptions = () => [...document.querySelectorAll('[data-znet-select-option]')];
      const syncIntervalLabels = new Map([
        [0, '手动'], [900, '15 分钟'], [1800, '30 分钟'],
        [3600, '1 小时'], [21600, '6 小时'], [86400, '24 小时'],
      ]);
      const sourceSyncInterval = source => source?.sync_interval_seconds ?? 900;
      const syncIntervalLabel = source => {
        const interval = sourceSyncInterval(source);
        return interval === 0 ? '手动' : `每 ${syncIntervalLabels.get(interval)}`;
      };

      function setSyncInterval(value) {
        if (!syncIntervalLabels.has(value)) throw new Error('自动同步间隔无效。');
        syncIntervalSeconds = value;
        for (const option of document.querySelectorAll('[data-sync-interval]')) {
          option.setAttribute('aria-checked', String(Number(option.dataset.syncInterval) === value));
        }
      }

      function setNetworkPath(value) {
        const options = networkPathOptions();
        const selected = options.find(option => option.dataset.value === value) || options[0];
        networkPath = selected.dataset.value;
        byId('networkPathValue').textContent = selected.textContent;
        for (const option of options) option.setAttribute('aria-selected', String(option === selected));
      }

      function setNetworkPathOpen(open, focusSelected = false) {
        byId('networkPath').setAttribute('aria-expanded', String(open));
        byId('networkPathOptions').hidden = !open;
        if (open && focusSelected) {
          networkPathOptions().find(option => option.getAttribute('aria-selected') === 'true')?.focus();
        }
      }

      function focusNetworkPathOption(offset) {
        const options = networkPathOptions();
        const current = Math.max(0, options.indexOf(document.activeElement));
        options[(current + offset + options.length) % options.length].focus();
      }

      function notice(message, kind = '') {
        const node = byId('notice');
        node.hidden = !message;
        node.setAttribute('data-znet-notice', kind || 'info');
        node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        node.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
        node.textContent = message || '';
        if (message && ['success', 'warning', 'error'].includes(kind)) {
          const action = activeAction || currentView;
          const labels = {
            save: '来源设置', login: '设备授权', bindSubscription: '订阅关联',
            syncNow: '手动同步', removeSource: '来源移除',
            retrySubscriptions: '订阅清单读取', changeSubscription: '订阅切换',
          };
          const level = kind === 'error' ? 'error' : kind === 'warning' ? 'warn' : 'info';
          const outcome = kind === 'success' ? '完成' : kind === 'warning' ? '需关注' : '失败';
          try {
            Promise.resolve(znetPlugin.logs?.write?.(component, level,
              `Connect ${labels[action] || '管理操作'}${outcome}`,
              {action, view: currentView, outcome: kind})).catch(() => {});
          } catch { /* Logging cannot interrupt an interactive operation. */ }
        }
      }

      function connectFailure(error) {
        const code = error?.connectCode || error?.code;
        const staged = detail => error?.connectStage ? `${error.connectStage}失败：${detail}` : detail;
        const protocolErrors = {
          invalid_credentials: '账号或密码不正确；请确认使用的是当前 ZBoard 账号。',
          reauthorization_required: '设备会话已过期，需要重新输入账号和密码授权。',
          authorization_revoked: '此设备授权已被服务端撤销，需要重新授权。',
          trust_mismatch: '服务身份与本机保存的信任记录不一致，请勿继续输入密码。',
          forbidden: '当前账号无权使用此订阅或读取该消息。',
          rate_limited: '服务请求过于频繁，请稍后再试。',
          temporary_unavailable: '服务暂时不可用，请稍后重试。',
        };
        if (protocolErrors[code]) return protocolErrors[code];
        if (code === 'communication_disabled') {
          return '来源已保存，但 ZBoard 尚未启用 Connect。请在 ZBoard 的“客户端通信”设置中启用后重试。';
        }
        if (code === 'permission_denied') {
          return staged('Connect 尚未获得客户端所需权限。请打开上方“权限”页，确认必需权限后启用。');
        }
        if (code === 'transport') {
          return staged('当前无法连接该服务。请检查网络、证书或连接方式后重试。');
        }
        if (/subscription response must be base64 encoded/u.test(error?.message || '')) {
          return `客户端未能解析服务返回的订阅内容，关联尚未完成。技术信息：${error.message}`;
        }
        return staged(error?.message || '无法验证服务');
      }

      async function atStage(stage, task) {
        try { return await task(); }
        catch (error) {
          if (error && !error.connectStage) error.connectStage = stage;
          throw error;
        }
      }

      async function settleHostOperations(operations) {
        const failures = [];
        for (const operation of operations) {
          try { await operation(); }
          catch (error) { failures.push(error); }
        }
        return failures;
      }

      function showView(id) {
        currentView = id;
        for (const view of views) byId(`view-${view}`).hidden = view !== id;
        byId('pageTitle').textContent = headings[id][0];
        byId('pageDescription').textContent = headings[id][1];
      }

      function checkState(id) {
        return latest?.checks?.find(check => check.id === id)?.state;
      }

      function render(value) {
        latest = value;
        const source = value.source;
        const ready = checkState('provider-capability') === 'ready';
        byId('serviceSource').textContent = source ? `${source.name} · ${source.origin}` : '尚未配置';
        byId('servicePath').textContent = source?.network_path === 'core' ? '通过代理内核' : '直接连接';
        byId('completeName').textContent = source?.name || '—';
        byId('completeOrigin').textContent = source?.origin || '—';
        byId('continueAccount').hidden = !ready;
        const result = byId('serviceResult');
        result.replaceChildren();
        const title = document.createElement('strong');
        if (ready) {
          byId('serviceTitle').textContent = '服务已确认';
          byId('serviceDescription').textContent = '此服务支持 Connect，可以继续授权设备。';
          title.textContent = '可以继续';
          result.append(title, document.createTextNode('服务身份已确认，下一步将授权当前设备。'));
        } else {
          const gap = value.capability_gap;
          byId('serviceTitle').textContent = gap?.code === 'communication_disabled' ? 'ZBoard 尚未启用 Connect' : '此服务暂未开放 Connect';
          byId('serviceDescription').textContent = '来源已经保存，但当前还不能继续授权设备。';
          title.textContent = '来源已保存';
          result.append(title, document.createTextNode(gap?.message || '该服务尚未提供 Connect 接入能力。你可以修改地址或稍后重试。'));
        }
      }

      const textEncoder = new TextEncoder();
      const textDecoder = new TextDecoder();
      const standardBase64 = bytes => {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      };
      const fromStandardBase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
      const base64Url = bytes => standardBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
      const fromBase64Url = value => {
        const standard = value.replaceAll('-', '+').replaceAll('_', '/');
        return fromStandardBase64(standard + '='.repeat((4 - standard.length % 4) % 4));
      };
      const utf8Base64 = value => standardBase64(textEncoder.encode(value));
      const bytesToHex = bytes => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
      const validIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value);
      const randomBytes = length => {
        const value = new Uint8Array(length);
        crypto.getRandomValues(value);
        return value;
      };
      const int64 = value => {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
        return bytes;
      };
      const transcript = fields => {
        const size = fields.reduce((total, field) => total + 4 + field.length, 0);
        const output = new Uint8Array(size);
        const view = new DataView(output.buffer);
        let offset = 0;
        for (const field of fields) {
          view.setUint32(offset, field.length, false);
          offset += 4;
          output.set(field, offset);
          offset += field.length;
        }
        return output;
      };
      const sdk = (capability, scope, method, argumentsValue = {}, maxResultBytes = 8 * 1024 * 1024) =>
        znetPlugin.capabilities.call(component, capability, scope, method, argumentsValue, {timeout_ms: 120000, max_result_bytes: maxResultBytes});
      const digest = async bytes => fromStandardBase64((await sdk('crypto.device.use', 'self', 'crypto_digest', {dataBase64: standardBase64(bytes)})).digestBase64);
      const secretGet = async key => {
        const result = await sdk('secrets.persistent.read', 'self', 'persistent_secret_get', {key});
        return result ? textDecoder.decode(fromStandardBase64(result.valueBase64)) : null;
      };
      const secretPut = (key, value) => sdk('secrets.persistent.write', 'self', 'persistent_secret_put', {key, valueBase64: utf8Base64(value)});
      const secretDelete = key => sdk('secrets.persistent.write', 'self', 'persistent_secret_delete', {key});
      const stateGet = async key => {
        const raw = await znetPlugin.storage.getJson(component, 'state', key);
        if (raw == null) return null;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      };
      const statePut = (key, value) => znetPlugin.storage.putJson(component, 'state', key, value);
      const sourceKey = suffix => {
        if (!activeSource?.id) throw new Error('请先选择来源。');
        return `source/${activeSource.id}/${suffix}`;
      };
      const sourceStateGet = suffix => stateGet(sourceKey(suffix));
      const sourceStatePut = (suffix, value) => statePut(sourceKey(suffix), value);
      const sourceSecretKey = suffix => sourceKey(suffix);
      const sourceTasks = source => [
        {taskId: `connect-sync-${source.id}`, action: `sync.${source.id}`},
        {taskId: `connect-usage-${source.id}`, action: `usage.${source.id}`},
        {taskId: `connect-messages-${source.id}`, action: `messages.${source.id}`},
      ];
      const ensureScheduledSync = async () => {
        const intervalSeconds = sourceSyncInterval(activeSource);
        const tasks = await sdk('tasks.schedule', 'self', 'schedule_list', {}, 65536);
        for (const {taskId, action} of sourceTasks(activeSource)) {
          const existing = tasks.find(task => task.taskId === taskId);
          if (intervalSeconds === 0) {
            if (existing) await sdk('tasks.schedule', 'self', 'schedule_delete', {taskId}, 65536);
          } else if (existing?.intervalSeconds !== intervalSeconds || existing.action !== action) {
            await sdk('tasks.schedule', 'self', 'schedule_put', {taskId, action, intervalSeconds}, 65536);
          }
        }
      };

      function validateSources(nextSources) {
        if (nextSources.length > 16) throw new Error('Connect 最多支持 16 个来源。');
        const ids = new Set();
        const origins = new Set();
        for (const source of nextSources) {
          const origin = new URL(source.origin);
          if (!validIdentifier(source.id) || ids.has(source.id) || !source.name || source.name.length > 80 ||
              origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
              !['direct', 'core'].includes(source.network_path) || !syncIntervalLabels.has(sourceSyncInterval(source))) {
            throw new Error('Connect 来源记录无效。');
          }
          if (origins.has(source.origin)) throw new Error('同一服务地址已存在，请管理现有来源。');
          ids.add(source.id);
          origins.add(source.origin);
        }
        return [...origins];
      }

      async function saveSources(nextSources, forceConfiguration = false) {
        const origins = validateSources(nextSources);
        const originsChanged = forceConfiguration || JSON.stringify(validateSources(sources)) !== JSON.stringify(origins);
        let current = null;
        if (originsChanged) {
          current = await znetPlugin.configuration.get(component);
          await znetPlugin.configuration.save(component, {provider_origins: JSON.stringify(origins)});
        }
        try {
          await statePut('sources/index', nextSources);
        } catch (error) {
          if (originsChanged) {
            try { await znetPlugin.configuration.save(component, current); }
            catch { throw new Error('来源未保存完整，配置回滚也失败。请保持页面打开并查看技术诊断。'); }
            throw new Error(`来源未保存，已恢复先前配置：${error.message || '插件状态写入失败'}`);
          }
          throw new Error(`来源未保存：${error.message || '插件状态写入失败'}`);
        }
        sources = nextSources;
      }

      async function selectSource(source) {
        activeSource = source;
        providerCapabilities = null;
        availableSubscriptions = [];
        selectedSubscriptionId = null;
        messageItems = [];
        byId('sourceName').value = source.name;
        byId('providerOrigin').value = source.origin;
        setNetworkPath(source.network_path || 'direct');
        setSyncInterval(sourceSyncInterval(source));
      }

      function renderSourceList() {
        const list = byId('sourceList');
        list.replaceChildren();
        if (!sources.length) {
          const empty = document.createElement('div');
          empty.setAttribute('data-znet-callout', '');
          const title = document.createElement('strong');
          title.textContent = '尚未添加来源';
          empty.append(title, document.createTextNode('添加 ZBoard 地址后再验证服务并授权设备。'));
          list.append(empty);
          return;
        }
        for (const source of sources) {
          const row = document.createElement('div');
          row.setAttribute('data-znet-status', 'ready');
          const mark = document.createElement('span');
          mark.setAttribute('data-znet-status-mark', '');
          const content = document.createElement('div');
          const title = document.createElement('strong');
          title.textContent = source.name;
          const meta = document.createElement('small');
          meta.textContent = `${source.origin} · ${source.network_path === 'core' ? '通过内核' : '直连'} · ${syncIntervalLabel(source)}`;
          const actions = document.createElement('div');
          actions.setAttribute('data-znet-actions', '');
          const open = document.createElement('button');
          open.type = 'button';
          open.setAttribute('data-variant', 'outline');
          open.textContent = '管理来源';
          open.addEventListener('click', () => {
            statusGeneration++;
            notice('');
            selectSource(source);
            showView('source');
          });
          const view = document.createElement('button');
          view.type = 'button';
          view.setAttribute('data-variant', 'ghost');
          view.textContent = '查看连接';
          view.addEventListener('click', () => runRequest(null, async () => {
            notice('正在读取连接状态…');
            try {
              selectSource(source);
              await openActiveSource();
              if (byId('notice').textContent === '正在读取连接状态…') notice('');
            } catch (error) {
              notice(`打开连接详情失败：${connectFailure(error)}`, 'error');
            }
          }));
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.setAttribute('data-variant', 'ghost');
          remove.className = 'connect-danger-action';
          remove.textContent = '移除';
          remove.setAttribute('aria-label', `移除来源 ${source.name}`);
          remove.addEventListener('click', () => runRequest(null, () => removeSourceRecord(source)));
          actions.append(open, view, remove);
          content.append(title, meta, actions);
          row.append(mark, content);
          list.append(row);
        }
      }

      async function configuredRequest(path, options = {}) {
        if (!activeSource) throw new Error('请先选择来源。');
        const origin = activeSource.origin;
        const route = activeSource.network_path || 'direct';
        const response = await atStage(
          `${options.method === 'POST' ? '提交加密请求' : '读取服务能力'}（${route === 'core' ? '通过代理内核' : '直接连接'}）`,
          () => sdk('network.configured.request', 'provider_origins', 'configured_request', {
            url: new URL(path, `${origin}/`).href,
            method: options.method || 'GET',
            headers: options.headers || {},
            ...(options.body == null ? {} : {body: options.body}),
            route,
          }),
        );
        let body;
        try { body = JSON.parse(response.body); }
        catch { throw new Error(`服务返回了无法识别的响应（HTTP ${response.status}）。`); }
        if (response.status < 200 || response.status >= 300) {
          const error = new Error(body.error === 'communication_disabled'
            ? '来源已保存，但 ZBoard 尚未启用 Connect。请在 ZBoard 的“客户端通信”设置中启用后重试。'
            : `服务拒绝了请求：${body.error || `HTTP ${response.status}`}`);
          error.connectCode = body.error;
          throw error;
        }
        return body;
      }

      async function verifyCapabilities(capabilities) {
        const origin = activeSource.origin;
        if (capabilities.protocol_version !== 1 || capabilities.provider_id !== origin ||
            capabilities.exchange_path !== '/.well-known/zerodenet-connect/v1/exchange') {
          throw new Error('服务返回的 Connect 身份或协议版本与当前来源不一致。');
        }
        const requiredOperations = [
          'authorization.password', 'authorization.renew', 'subscriptions.list',
          'subscriptions.get-content', 'messages.list',
        ];
        if (!Array.isArray(capabilities.operations) ||
            requiredOperations.some(operation => !capabilities.operations.includes(operation))) {
          throw new Error('服务没有声明客户端所需的 Connect 操作。');
        }
        const identityPublic = fromBase64Url(capabilities.identity_public_key);
        if (identityPublic.length !== 32 || !validIdentifier(capabilities.identity_key_id)) {
          throw new Error('服务身份公钥或标识无效。');
        }
        const fingerprint = base64Url(await digest(identityPublic));
        if (fingerprint !== capabilities.identity_fingerprint) throw new Error('服务身份指纹校验失败。');
        const statement = capabilities.provider_key_statement;
        const now = Math.floor(Date.now() / 1000);
        const statementPublic = fromBase64Url(statement.hpke_public_key);
        const statementSignature = fromBase64Url(statement.signature);
        if (statement.protocol_version !== 1 || statement.provider_id !== origin ||
            statement.identity_key_id !== capabilities.identity_key_id ||
            !validIdentifier(statement.key_id) || statementPublic.length !== 32 || statementSignature.length !== 64 ||
            statement.not_before <= 0 || statement.not_after <= statement.not_before ||
            statement.not_after - statement.not_before > 90 * 24 * 60 * 60 ||
            statement.not_before > now + 30 || statement.not_after < now - 30) {
          throw new Error('服务通信密钥声明无效或已经过期。');
        }
        const statementInput = transcript([
          textEncoder.encode('zerodenet-connect/v1/provider-key'),
          textEncoder.encode(statement.provider_id),
          textEncoder.encode(statement.identity_key_id),
          textEncoder.encode(statement.key_id),
          textEncoder.encode(statement.hpke_public_key),
          int64(statement.not_before),
          int64(statement.not_after),
        ]);
        const verified = await sdk('crypto.device.use', 'self', 'crypto_verify', {
          publicKeyBase64: standardBase64(identityPublic),
          dataBase64: standardBase64(statementInput),
          signatureBase64: standardBase64(statementSignature),
        });
        if (!verified.valid) throw new Error('服务通信密钥签名校验失败。');
        const pinned = await secretGet(sourceSecretKey('trust/provider'));
        const nextPin = JSON.stringify({provider_id: origin, identity_key_id: capabilities.identity_key_id, identity_public_key: capabilities.identity_public_key, identity_fingerprint: fingerprint});
        if (pinned && pinned !== nextPin) throw new Error('服务身份与本机已确认的身份不一致，请勿继续输入密码。');
        if (!pinned) await secretPut(sourceSecretKey('trust/provider'), nextPin);
        return capabilities;
      }

      async function loadCapabilities() {
        providerCapabilities = await atStage('验证服务身份', async () => verifyCapabilities(
          await configuredRequest('/.well-known/zerodenet-connect/v1/capabilities'),
        ));
        return providerCapabilities;
      }

      async function deviceIdentity() {
        const keyName = activeSource.device_key_name || `connect-device-${activeSource.id}`;
        const key = await sdk('crypto.device.use', 'self', 'crypto_key_generate', {keyName});
        let identity = await sourceStateGet('device/identity');
        if (!identity) {
          identity = {device_id: `device-${bytesToHex(randomBytes(16))}`, source_id: activeSource.id};
          await sourceStatePut('device/identity', identity);
        }
        return {...identity, public_key: base64Url(fromStandardBase64(key.publicKeyBase64))};
      }

      async function exchange(operation, authorization, body) {
        const capabilities = providerCapabilities || await loadCapabilities();
        const identity = await atStage('准备设备身份', deviceIdentity);
        const responseKey = await atStage('生成会话密钥', () => sdk('crypto.device.use', 'self', 'crypto_hpke_key_generate'));
        const requestId = base64Url(randomBytes(16));
        const issuedAt = Math.floor(Date.now() / 1000);
        const bodyRaw = JSON.stringify(body);
        const responsePublicKey = base64Url(fromStandardBase64(responseKey.publicKeyBase64));
        const credentialHash = await digest(textEncoder.encode(authorization.credential));
        const bodyHash = await digest(textEncoder.encode(bodyRaw));
        const proofInput = transcript([
          textEncoder.encode('zerodenet-connect/v1/device-proof'),
          textEncoder.encode(operation), textEncoder.encode(requestId), int64(issuedAt), int64(issuedAt + 120),
          textEncoder.encode(identity.source_id), textEncoder.encode(identity.device_id),
          textEncoder.encode(identity.public_key), textEncoder.encode(responsePublicKey),
          textEncoder.encode(authorization.kind), credentialHash, bodyHash,
        ]);
        const signature = await sdk('crypto.device.use', 'self', 'crypto_sign', {keyName: activeSource.device_key_name || `connect-device-${activeSource.id}`, dataBase64: standardBase64(proofInput)});
        const message = {
          protocol_version: 1, operation, request_id: requestId, issued_at: issuedAt, expires_at: issuedAt + 120,
          source_id: identity.source_id, device_id: identity.device_id, device_public_key: identity.public_key,
          response_public_key: responsePublicKey, authorization, body: JSON.parse(bodyRaw),
          device_proof: base64Url(fromStandardBase64(signature.signatureBase64)),
        };
        const keyId = capabilities.provider_key_statement.key_id;
        const requestInfo = textEncoder.encode(`zerodenet-connect/v1/request/${keyId}`);
        const requestAad = textEncoder.encode(`zerodenet-connect/v1/request\0${keyId}\0${requestId}`);
        const sealed = await atStage('加密请求', () => sdk('crypto.device.use', 'self', 'crypto_hpke_seal', {
          recipientPublicKeyBase64: standardBase64(fromBase64Url(capabilities.provider_key_statement.hpke_public_key)),
          infoBase64: standardBase64(requestInfo), aadBase64: standardBase64(requestAad),
          plaintextBase64: utf8Base64(JSON.stringify(message)),
        }));
        const envelope = {
          protocol_version: 1, suite: 'HPKE-0x0020-0x0001-0x0003', key_id: keyId, request_id: requestId,
          encapsulation: base64Url(fromStandardBase64(sealed.encapsulationBase64)),
          ciphertext: base64Url(fromStandardBase64(sealed.ciphertextBase64)),
        };
        const responseEnvelope = await configuredRequest(capabilities.exchange_path, {
          method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(envelope),
        });
        if (responseEnvelope.protocol_version !== 1 || responseEnvelope.suite !== envelope.suite ||
            responseEnvelope.key_id !== keyId || responseEnvelope.request_id !== requestId) {
          throw new Error('服务响应与当前请求不匹配。');
        }
        const responseInfo = textEncoder.encode(`zerodenet-connect/v1/response/${keyId}`);
        const responseAad = textEncoder.encode(`zerodenet-connect/v1/response\0${keyId}\0${requestId}`);
        const opened = await atStage('解密服务响应', () => sdk('crypto.device.use', 'self', 'crypto_hpke_open', {
          privateKeyHandle: responseKey.privateKeyHandle,
          senderPublicKeyBase64: standardBase64(fromBase64Url(capabilities.provider_key_statement.hpke_public_key)),
          infoBase64: standardBase64(responseInfo), aadBase64: standardBase64(responseAad),
          encapsulationBase64: standardBase64(fromBase64Url(responseEnvelope.encapsulation)),
          ciphertextBase64: standardBase64(fromBase64Url(responseEnvelope.ciphertext)),
        }));
        const response = JSON.parse(textDecoder.decode(fromStandardBase64(opened.plaintextBase64)));
        const responseNow = Math.floor(Date.now() / 1000);
        if (response.protocol_version !== 1 || response.operation !== operation || response.request_id !== requestId ||
            response.issued_at <= 0 || response.expires_at <= response.issued_at ||
            response.expires_at - response.issued_at > 120 ||
            response.issued_at > responseNow + 30 || response.expires_at < responseNow - 30) {
          throw new Error('服务响应消息无效或已经过期。');
        }
        if (response.status === 'error') {
          const error = new Error(`Connect 请求失败：${response.error?.code || 'unknown'}`);
          error.connectCode = response.error?.code;
          throw error;
        }
        if (response.status !== 'ok' || response.body == null) throw new Error('服务响应消息缺少结果。');
        return response.body;
      }

      async function saveSession(result) {
        if (!result?.access_credential || !result?.renewal_credential ||
            !Number.isFinite(result.access_expires_at) || !Number.isFinite(result.renewal_expires_at)) {
          throw new Error('服务返回的设备会话不完整。');
        }
        try {
          await secretPut(sourceSecretKey('session/access'), result.access_credential);
          await secretPut(sourceSecretKey('session/renewal'), result.renewal_credential);
          await sourceStatePut('session/metadata', {
            user_id: result.user_id, device_id: result.device_id,
            access_expires_at: result.access_expires_at, renewal_expires_at: result.renewal_expires_at,
          });
        } catch (error) {
          const rollbackFailures = await settleHostOperations([
            () => secretDelete(sourceSecretKey('session/access')),
            () => secretDelete(sourceSecretKey('session/renewal')),
            () => znetPlugin.storage.delete(component, 'state', sourceKey('session/metadata')),
          ]);
          const failure = new Error(rollbackFailures.length
            ? '客户端写入会话状态失败，清理结果也未能确认。请不要继续关联订阅。'
            : `客户端写入会话状态失败，已清除本次凭据；可以重试授权。${error?.message || ''}`);
          failure.connectStage = '保存设备会话';
          throw failure;
        }
        try { await ensureScheduledSync(); return null; }
        catch (error) { return `后台同步尚未启用：${connectFailure(error)}`; }
      }

      async function accessAuthorization() {
        const metadata = await sourceStateGet('session/metadata');
        if (!metadata) throw new Error('请先授权当前设备。');
        const now = Math.floor(Date.now() / 1000);
        let access = await secretGet(sourceSecretKey('session/access'));
        if (access && metadata.access_expires_at > now + 30) return {kind: 'access', credential: access};
        const renewal = await secretGet(sourceSecretKey('session/renewal'));
        if (!renewal || metadata.renewal_expires_at <= now + 30) throw new Error('设备授权已过期，请重新登录。');
        let renewed;
        try {
          renewed = await exchange('authorization.renew', {kind: 'renewal', credential: renewal}, {});
        } catch (error) {
          if (['communication_disabled', 'reauthorization_required', 'authorization_revoked', 'replay_rejected', 'unauthorized'].includes(error.connectCode)) {
            const cleanupFailures = await settleHostOperations([
              () => secretDelete(sourceSecretKey('session/access')),
              () => secretDelete(sourceSecretKey('session/renewal')),
              () => znetPlugin.storage.delete(component, 'state', sourceKey('session/metadata')),
            ]);
            if (cleanupFailures.length) throw cleanupFailures[0];
          }
          throw error;
        }
        await saveSession(renewed);
        access = renewed.access_credential;
        return {kind: 'access', credential: access};
      }

      function renderSubscriptions(items, currentId = null) {
        availableSubscriptions = items;
        selectedSubscriptionId = items.find(item => item.subscription_id === currentId)?.subscription_id || items[0]?.subscription_id || null;
        byId('subscriptionHint').textContent = currentId
          ? '选择新的订阅。新订阅成功写入后，未被其他来源使用的旧订阅会从客户端移除。'
          : '选择要交给客户端托管的订阅，然后确认关联。';
        byId('bindSubscription').textContent = currentId ? '确认选择' : '确认关联';
        const list = byId('subscriptionList');
        list.replaceChildren();
        if (!items.length) {
          const strong = document.createElement('strong');
          strong.textContent = '没有可用订阅';
          list.append(strong, document.createTextNode('当前账号没有可投影到客户端的订阅。'));
        } else {
          for (const item of items) {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer';
            const input = document.createElement('input');
            input.type = 'radio'; input.name = 'connect-subscription'; input.value = item.subscription_id; input.checked = item.subscription_id === selectedSubscriptionId;
            input.style.width = 'auto'; input.style.height = 'auto';
            input.addEventListener('change', () => { selectedSubscriptionId = input.value; });
            const text = document.createElement('span');
            text.textContent = `${item.display_name}${item.subscription_id === currentId ? '（当前）' : ''}`;
            label.append(input, text); list.append(label);
          }
        }
        byId('bindSubscription').disabled = !selectedSubscriptionId;
      }

      async function listSubscriptions() {
        const authorization = await accessAuthorization();
        const result = await exchange('subscriptions.list', authorization, {});
        const binding = await sourceStateGet('subscription/binding');
        renderSubscriptions(result.subscriptions || [], binding?.remote_subscription_id);
        return result.subscriptions || [];
      }

      async function refreshAccountProfile() {
        const label = byId('completeAccount');
        label.textContent = '正在读取…';
        if (!providerCapabilities?.operations?.includes('account.me')) {
          label.textContent = '服务未提供账号信息';
          return;
        }
        try {
          const account = await exchange('account.me', await accessAuthorization(), {});
          if (typeof account.email !== 'string' || !account.email.trim()) throw new Error('账号信息无效');
          label.textContent = account.email;
        } catch (error) {
          label.textContent = `读取失败：${connectFailure(error)}`;
        }
      }

      function subscriptionContentForHost(projected) {
        if (typeof projected.content !== 'string' || !projected.content) {
          throw new Error('服务没有返回可用的订阅内容。');
        }
        // ZBoard's plugin projection returns rendered JSON, while the client's
        // znet-sink subscription format accepts the Base64 delivery form.
        if (projected.format === 'znet-sink' && projected.content.trimStart().startsWith('{')) {
          try { JSON.parse(projected.content); }
          catch { throw new Error('服务返回的 ZNet Sink 订阅不是有效 JSON。'); }
          return utf8Base64(projected.content);
        }
        return projected.content;
      }

      async function refreshSubscriptionUsage(subscriptionId, authorization) {
        if (!providerCapabilities?.operations?.includes('subscriptions.usage')) {
          await sourceStatePut('subscription/usage_error', {message: usageUnavailableMessage, checked_at: Date.now()}).catch(() => {});
          return usageUnavailableMessage;
        }
        try {
          const usage = await exchange('subscriptions.usage', authorization, {subscription_id: subscriptionId});
          const valid = usage.subscription_id === subscriptionId &&
            ['used_bytes', 'total_bytes', 'expire_at_unix_ms'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0) &&
            usage.total_bytes > 0 && usage.expire_at_unix_ms > 0;
          if (!valid) throw new Error('服务返回的订阅用量信息无效。');
          await sdk('subscriptions.manage', 'self', 'subscription_metadata_update', {
            providerId: providerCapabilities.provider_id,
            remoteSubscriptionId: subscriptionId,
            usage: {usedBytes: usage.used_bytes, totalBytes: usage.total_bytes, expireAtUnixMs: usage.expire_at_unix_ms},
          });
          await sourceStatePut('subscription/usage_checked_at', Date.now()).catch(() => {});
          await sourceStatePut('subscription/usage_error', null).catch(() => {});
          return null;
        } catch (error) {
          const message = error?.message === '插件宿主操作失败'
            ? '订阅配置已同步，但当前客户端未提供托管订阅用量写入能力。请升级到包含 subscription_metadata_update 的客户端版本后重试。'
            : connectFailure(error);
          await sourceStatePut('subscription/usage_error', {message, checked_at: Date.now()}).catch(() => {});
          return message;
        }
      }

      async function pullSubscription(subscriptionId, subscriptionName, {force = false} = {}) {
        const authorization = await accessAuthorization();
        const existingBinding = await sourceStateGet('subscription/binding');
        const appliedRevision = await sourceStateGet('subscription/applied_revision');
        const alreadyManaged = existingBinding?.remote_subscription_id === subscriptionId;
        const knownRevision = !force && alreadyManaged &&
          appliedRevision?.remote_subscription_id === subscriptionId &&
          appliedRevision?.revision === existingBinding.revision
          ? appliedRevision.revision : null;
        // Existing plans may stop projecting configuration when expired or exhausted.
        // Refresh quota before that request so their final usage remains visible.
        const previousUsageError = alreadyManaged
          ? await refreshSubscriptionUsage(subscriptionId, authorization) : null;
        const projected = await exchange('subscriptions.get-content', authorization, {
          subscription_id: subscriptionId,
          known_revision: knownRevision,
        });
        if (projected.not_modified === true) {
          if (!knownRevision || projected.revision !== knownRevision) {
            throw new Error('Connect 服务返回的未变化版本与已应用订阅不一致。');
          }
          await sdk('subscriptions.manage', 'self', 'subscription_sync_complete', {
            providerId: providerCapabilities.provider_id,
            remoteSubscriptionId: subscriptionId,
            revision: knownRevision,
          });
          return {notModified: true, usageError: previousUsageError};
        }
        const content = subscriptionContentForHost(projected);
        const profile = await sdk('subscriptions.manage', 'self', 'subscription_apply', {
          providerId: providerCapabilities.provider_id,
          remoteSubscriptionId: subscriptionId,
          sourceName: activeSource.name,
          subscriptionName: projected.display_name || subscriptionName,
          content,
          format: projected.format,
          revision: projected.revision,
        });
        const binding = {
          id: profile.id,
          name: profile.name,
          remote_subscription_id: subscriptionId,
          revision: projected.revision,
        };
        await sourceStatePut('subscription/binding', binding);
        // This marker is deliberately separate from the protocol binding. Older
        // plugin/client combinations could advance the binding revision without
        // durably replacing the managed profile. Absence or disagreement forces
        // one full projection + apply, which repairs that historical split-brain.
        await sourceStatePut('subscription/applied_revision', {
          remote_subscription_id: subscriptionId,
          revision: projected.revision,
        });
        // The host's subscription_apply replaces quota metadata. Restore the
        // provider's latest usage after every content apply, including updates.
        const usageError = await refreshSubscriptionUsage(subscriptionId, authorization);
        byId('completeName').textContent = profile.name;
        byId('completeOrigin').textContent = providerCapabilities.provider_id;
        return {notModified: false, profile, binding, usageError};
      }

      async function removePendingSubscription() {
        const pending = await sourceStateGet('subscription/pending_removal');
        if (!pending?.id) return null;
        const current = await sourceStateGet('subscription/binding');
        if (current?.id === pending.id) {
          await znetPlugin.storage.delete(component, 'state', sourceKey('subscription/pending_removal'));
          return null;
        }
        const others = sources.filter(source => source.id !== activeSource.id && source.origin === activeSource.origin);
        for (const source of others) {
          const binding = await stateGet(`source/${source.id}/subscription/binding`);
          if (binding?.id === pending.id) {
            await znetPlugin.storage.delete(component, 'state', sourceKey('subscription/pending_removal'));
            return null;
          }
        }
        try {
          await sdk('subscriptions.manage', 'self', 'subscription_remove', {
            subscriptionId: pending.id, removeAssociatedConfig: true,
          });
        } catch (error) {
          if (error?.code !== 'not_found') throw error;
        }
        await znetPlugin.storage.delete(component, 'state', sourceKey('subscription/pending_removal'));
        return null;
      }

      async function selectSubscription(item) {
        await removePendingSubscription();
        const previous = await sourceStateGet('subscription/binding');
        const changing = previous?.id && previous.remote_subscription_id !== item.subscription_id;
        if (changing) await sourceStatePut('subscription/pending_removal', {id: previous.id});
        let result;
        try { result = await pullSubscription(item.subscription_id, item.display_name); }
        catch (error) {
          if (changing) {
            const current = await sourceStateGet('subscription/binding').catch(() => null);
            if (current?.id === previous.id) {
              await znetPlugin.storage.delete(component, 'state', sourceKey('subscription/pending_removal')).catch(() => {});
            }
          }
          throw error;
        }
        if (changing && previous.id !== result.binding?.id) {
          try { await removePendingSubscription(); }
          catch (error) { result.removalError = connectFailure(error); }
        } else if (changing) {
          await znetPlugin.storage.delete(component, 'state', sourceKey('subscription/pending_removal'));
        }
        return result;
      }

      function renderMessages(items) {
        messageItems = items;
        const list = byId('messageList');
        list.replaceChildren();
        if (!items.length) {
          const empty = document.createElement('div');
          empty.setAttribute('data-znet-callout', '');
          const title = document.createElement('strong');
          title.textContent = '暂无消息';
          empty.append(title, document.createTextNode('服务当前没有向此账号投影消息。'));
          list.append(empty);
          return;
        }
        for (const item of items) {
          const row = document.createElement('div');
          row.setAttribute('data-znet-status', item.read_at == null ? 'action_required' : 'ready');
          const mark = document.createElement('span');
          mark.setAttribute('data-znet-status-mark', '');
          const content = document.createElement('div');
          content.className = 'connect-message-content';
          const title = document.createElement('strong');
          title.textContent = item.title || '未命名消息';
          const meta = document.createElement('small');
          meta.textContent = `${item.read_at == null ? '未读' : '已读'} · ${item.published_at ? new Date(item.published_at * 1000).toLocaleString() : '发布时间未知'}`;
          const open = document.createElement('button');
          open.type = 'button';
          open.setAttribute('data-variant', 'ghost');
          open.textContent = '查看';
          open.addEventListener('click', () => runRequest(null, () => openMessage(item.message_id)));
          content.append(title, meta, open);
          row.append(mark, content);
          list.append(row);
        }
      }

      async function openMessage(messageId) {
        notice('');
        try {
          const authorization = await accessAuthorization();
          const message = await exchange('messages.get', authorization, {message_id: messageId});
          byId('messageDetailTitle').textContent = message.title || '消息';
          byId('messageDetailBody').textContent = message.body || '';
          byId('messageDetailMeta').textContent = message.published_at
            ? new Date(message.published_at * 1000).toLocaleString() : '';
          if (!byId('messageDialog').open) byId('messageDialog').showModal();
          const summary = messageItems.find(item => item.message_id === messageId);
          if (summary?.read_at == null) {
            await exchange('messages.mark-read', await accessAuthorization(), {message_id: messageId});
            await synchronizeMessages(false);
          }
        } catch (error) {
          notice(error.message || '无法读取消息', 'error');
        }
      }

      async function synchronizeMessages(notify = true) {
        const authorization = await accessAuthorization();
        const page = await exchange('messages.list', authorization, {cursor: null, limit: 20});
        const items = page.messages || [];
        const unread = items.filter(message => message.read_at == null);
        const previous = await sourceStateGet('messages/summary');
        const previousUnread = new Set((previous?.items || []).filter(message => message.read_at == null).map(message => message.message_id));
        const newUnread = unread.filter(message => !previousUnread.has(message.message_id));
        let notificationFailed = false;
        if (notify && newUnread.length) {
          try {
            await sdk('notifications.post', 'self', 'notification_post', {
              kind: 'info', message: `Connect 有 ${newUnread.length} 条新消息`, duration_ms: 5000,
              action: {pageId: 'manage', route: `messages.${activeSource.id}`, reference: newUnread[0]?.message_id},
            }, 65536);
          } catch {
            notificationFailed = true;
          }
        }
        await sourceStatePut('messages/summary', {checked_at: Date.now(), unread: unread.length, items});
        renderMessages(items);
        if (notificationFailed) {
          try {
            await znetPlugin.logs?.write?.(component, 'warn', 'Connect 消息已同步，通知未送达',
              {action: 'messages', outcome: 'notification_failed'});
          } catch { /* Logging must not change the message result. */ }
        }
        return {notificationFailed};
      }

      async function currentStatus() {
        const configured = Boolean(activeSource?.name && activeSource?.origin && activeSource?.network_path);
        let providerReady = false;
        let providerError = null;
        let providerErrorCode = null;
        if (configured) {
          try { await loadCapabilities(); providerReady = true; }
          catch (error) {
            providerError = connectFailure(error);
            providerErrorCode = error?.connectCode || error?.code || 'provider_unavailable';
          }
        }
        const session = configured ? await sourceStateGet('session/metadata') : null;
        const binding = configured ? await sourceStateGet('subscription/binding') : null;
        const storedUsageError = configured && binding ? await sourceStateGet('subscription/usage_error') : null;
        const usageCapabilityRecovered = providerReady && binding &&
          providerCapabilities?.operations?.includes('subscriptions.usage') &&
          storedUsageError?.message === usageUnavailableMessage;
        const usageError = configured && binding
          ? !providerCapabilities?.operations?.includes('subscriptions.usage') && providerReady
            ? {message: usageUnavailableMessage}
            : usageCapabilityRecovered ? null : storedUsageError
          : null;
        const usageCheckedAt = configured && binding ? await sourceStateGet('subscription/usage_checked_at') : null;
        return {
          schema_version: 1, product_id: 'org.zerodenet.connect', adapter: 'znet-sink',
          phase: !configured ? 'needs-configuration' : !providerReady ? 'blocked' : binding ? 'ready' : session ? 'needs-subscription' : 'needs-authorization',
          source: configured ? {name: activeSource.name, origin: activeSource.origin, network_path: activeSource.network_path} : null,
          checks: [
            {id:'source-configuration', label:'来源配置', state:configured?'ready':'action_required', detail:configured?`${activeSource.name} · ${activeSource.origin}`:'请先完成来源配置。'},
            {id:'provider-capability', label:'远端 Connect 服务', state:providerReady?'ready':configured?'blocked':'waiting', detail:providerReady?'服务身份和通信密钥已验证。':providerError || '保存后检查。'},
            {id:'service-identity', label:'服务身份与设备密钥', state:providerReady?'ready':'waiting', detail:providerReady?'身份已固定，设备私钥由客户端保管。':'等待服务验证。'},
            {id:'account-authorization', label:'账号授权', state:session?'ready':'waiting', detail:session?'当前设备已授权。':'密码仅用于一次授权。'},
            {id:'subscription-binding', label:'订阅关联', state:binding?'ready':'waiting', detail:binding
              ? `${binding.name}${usageError?.message ? ` · 流量信息：${usageError.message}` : ''}` : '授权后选择订阅。'},
            {id:'subscription-usage', label:'流量与到期时间', state:binding?(usageError?.message?'action_required':usageCapabilityRecovered?'waiting':usageCheckedAt?'ready':'waiting'):'waiting',
              detail:binding?(usageError?.message || (usageCapabilityRecovered ? '服务已开放订阅用量能力，请点击“立即同步”刷新流量和到期时间。' : usageCheckedAt ? '最近一次用量已写入客户端。' : '等待首次用量同步。')):'关联订阅后检查。'},
            {id:'messages', label:'消息', state:session?'ready':'waiting', detail:session?'消息投影已可用。':'授权后可用。'},
          ],
          capability_gap: providerError ? {
            code:providerErrorCode,
            owner:providerErrorCode === 'permission_denied' ? 'host' : 'provider',
            message:providerError,
          } : null,
        };
      }

      async function invoke(action, payload = null) {
        if (action === 'status.get' || action === 'diagnostics.run') return currentStatus();
        if (action === 'authorization.password') {
          await loadCapabilities();
          const result = await atStage('授权设备', () => exchange('authorization.password', {kind:'password', credential:payload.password}, {
            account: payload.account, device_name: `ZNet Sink · ${navigator.platform || '本机'}`,
          }));
          const syncWarning = await saveSession(result);
          let subscriptionWarning = null;
          try { await atStage('读取订阅清单', listSubscriptions); }
          catch (error) { subscriptionWarning = connectFailure(error); }
          const warnings = [syncWarning, subscriptionWarning].filter(Boolean);
          return {
            ok:true,
            message: warnings.length
              ? `设备已授权，但${warnings.join('；')}。可在下一步重试，不需要重新输入密码。`
              : '设备授权成功，请选择订阅。',
          };
        }
        throw new Error('当前 Connect 版本不支持此操作。');
      }

      async function clearActiveSourceRuntime(removeSubscription) {
        if (!activeSource) return;
        if (removeSubscription) await removePendingSubscription();
        const binding = await sourceStateGet('subscription/binding');
        if (removeSubscription && binding?.id) {
          await sdk('subscriptions.manage', 'self', 'subscription_remove', {
            subscriptionId: binding.id,
            removeAssociatedConfig: true,
          });
        }
        const cleanupFailures = await settleHostOperations([
          () => secretDelete(sourceSecretKey('trust/provider')),
          () => secretDelete(sourceSecretKey('session/access')),
          () => secretDelete(sourceSecretKey('session/renewal')),
          () => secretDelete(`keys/${activeSource.device_key_name || `connect-device-${activeSource.id}`}`),
          ...sourceTasks(activeSource).map(({taskId}) => () => sdk('tasks.schedule', 'self', 'schedule_delete', {taskId}, 65536)),
          () => znetPlugin.storage.delete(component, 'state', sourceKey('device/identity')),
          () => znetPlugin.storage.delete(component, 'state', sourceKey('session/metadata')),
          () => znetPlugin.storage.delete(component, 'state', sourceKey('subscription/binding')),
          () => znetPlugin.storage.delete(component, 'state', sourceKey('subscription/applied_revision')),
          () => znetPlugin.storage.delete(component, 'state', sourceKey('subscription/usage_error')),
          () => znetPlugin.storage.delete(component, 'state', sourceKey('subscription/usage_checked_at')),
          () => znetPlugin.storage.delete(component, 'state', sourceKey('subscription/pending_removal')),
          () => znetPlugin.storage.delete(component, 'state', sourceKey('messages/summary')),
        ]);
        if (cleanupFailures.length) throw cleanupFailures[0];
      }

      async function removeSourceRecord(source) {
        try {
          const binding = await stateGet(`source/${source.id}/subscription/binding`);
          const sameOrigin = sources.filter(item => item.id !== source.id && item.origin === source.origin);
          const sharedBindings = [];
          for (const item of sameOrigin) sharedBindings.push(await stateGet(`source/${item.id}/subscription/binding`));
          const sharedSubscription = binding?.id && sharedBindings.some(item => item?.id === binding.id);
          const consequence = sharedSubscription
            ? '该托管订阅仍由同地址的其他来源使用，不会删除订阅。'
            : '对应的客户端托管订阅及其关联配置也会一并移除。';
          if (!confirm(`确定移除来源“${source.name}”吗？${consequence}`)) return;
          await selectSource(source);
          await clearActiveSourceRuntime(!sharedSubscription);
          await saveSources(sources.filter(item => item.id !== source.id));
          activeSource = null;
          renderSourceList();
          showView('sources');
          notice(sharedSubscription
            ? '来源和设备授权已移除；共享的托管订阅由其他来源保留。'
            : '来源、设备授权和托管订阅已移除。', 'success');
        } catch (error) {
          notice(`移除来源失败：${connectFailure(error)}；请重试。`, 'error');
        }
      }

      async function openActiveSource() {
        const value = await refreshStatus();
        if (value?.phase === 'ready') {
          const binding = await sourceStateGet('subscription/binding');
          const messageSummary = await sourceStateGet('messages/summary');
          byId('completeName').textContent = binding?.name || activeSource.name;
          byId('completeOrigin').textContent = activeSource.origin;
          byId('completeSyncInterval').textContent = syncIntervalLabel(activeSource);
          renderMessages(messageSummary?.items || []);
          await ensureScheduledSync().catch(error => notice(error.message || '无法启用后台同步', 'error'));
          showView('complete');
          await refreshAccountProfile();
          const usageCheck = value.checks.find(check => check.id === 'subscription-usage');
          if (usageCheck?.state === 'action_required') notice(usageCheck.detail, 'warning');
          await removePendingSubscription().catch(error => notice(`旧订阅移除失败：${connectFailure(error)}`, 'warning'));
          return value;
        }
        if (value?.phase === 'needs-subscription') {
          showView('subscriptions');
          try { await atStage('读取订阅清单', listSubscriptions); }
          catch (error) { notice(`${connectFailure(error)}；可直接重试，无需重新授权。`, 'error'); }
        } else if (value?.source) {
          showView('service');
        } else {
          showView('source');
        }
        return value;
      }

      async function runRequest(buttonId, task) {
        if (requestInFlight) return;
        requestInFlight = true;
        activeAction = buttonId;
        const button = buttonId ? byId(buttonId) : null;
        if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
        try { return await task(); }
        finally {
          requestInFlight = false;
          activeAction = null;
          if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
        }
      }

      async function refreshStatus() {
        const generation = ++statusGeneration;
        try {
          const value = await invoke('status.get');
          if (generation !== statusGeneration) return null;
          render(value);
          return value;
        } catch (error) {
          if (generation !== statusGeneration) return null;
          notice(`${error.message || '无法检查服务'}；来源设置仍可修改。`, 'error');
          return null;
        }
      }

      byId('save').addEventListener('click', () => runRequest('save', async () => {
        notice(''); statusGeneration++;
        try {
          const editingExisting = Boolean(activeSource);
          const sourceName = byId('sourceName').value.trim();
          if (!sourceName) throw new Error('请输入名称。');
          const origin = new URL(byId('providerOrigin').value.trim());
          if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
            throw new Error('服务地址必须是只包含主机和可选端口的 HTTPS 地址。');
          }
          if (activeSource && activeSource.origin !== origin.origin) {
            const binding = await sourceStateGet('subscription/binding');
            const session = await sourceStateGet('session/metadata');
            const trust = await secretGet(sourceSecretKey('trust/provider'));
            if (binding || session || trust) {
              throw new Error('来源已有服务信任或设备授权。请先移除旧来源，再添加新地址，避免遗留托管订阅和密钥。');
            }
          }
          const source = {
            ...(activeSource || {}),
            id: activeSource?.id || `source-${bytesToHex(randomBytes(16))}`,
            name: sourceName,
            origin: origin.origin,
            network_path: networkPath,
            sync_interval_seconds: syncIntervalSeconds,
            device_key_name: activeSource?.device_key_name || `connect-device-${activeSource?.id || bytesToHex(randomBytes(12))}`,
          };
          const next = activeSource
            ? sources.map(item => item.id === activeSource.id ? source : item)
            : [...sources, source];
          const hasSession = editingExisting && Boolean(await sourceStateGet('session/metadata'));
          await saveSources(next);
          activeSource = source;
          let scheduleError = null;
          if (hasSession) {
            await ensureScheduledSync().catch(error => { scheduleError = error; });
          }
          renderSourceList();
          latest = latest || {checks: []};
          latest.source = source;
          if (editingExisting) {
            showView('sources');
            notice(scheduleError
              ? `来源设置已保存，但后台同步任务未更新：${connectFailure(scheduleError)}`
              : `来源设置已保存，自动同步：${syncIntervalLabel(source)}。`, scheduleError ? 'error' : 'success');
            return;
          }
          showView('service');
          await refreshStatus();
        } catch (error) {
          notice(connectFailure(error), 'error');
        }
      }));

      byId('editSource').addEventListener('click', () => { notice(''); showView('source'); });
      byId('refresh').addEventListener('click', () => runRequest('refresh', async () => { notice(''); await refreshStatus(); }));
      byId('continueAccount').addEventListener('click', () => showView('account'));
      byId('backServiceSources').addEventListener('click', () => { renderSourceList(); showView('sources'); });
      byId('backService').addEventListener('click', () => showView('service'));
      byId('backAccount').addEventListener('click', () => runRequest('backAccount', async () => {
        const binding = await sourceStateGet('subscription/binding');
        showView(binding ? 'complete' : 'account');
      }));
      byId('changeSubscription').addEventListener('click', () => runRequest('changeSubscription', async () => {
        notice('');
        try {
          await atStage('读取订阅清单', listSubscriptions);
          showView('subscriptions');
        } catch (error) { notice(connectFailure(error), 'error'); }
      }));
      byId('retrySubscriptions').addEventListener('click', () => runRequest('retrySubscriptions', async () => {
        notice('');
        try { await atStage('读取订阅清单', listSubscriptions); }
        catch (error) { notice(connectFailure(error), 'error'); }
      }));
      byId('manageSource').addEventListener('click', () => showView('source'));
      byId('backSources').addEventListener('click', () => { renderSourceList(); showView('sources'); });
      byId('backCompleteSources').addEventListener('click', () => { renderSourceList(); showView('sources'); });
      byId('addSource').addEventListener('click', () => {
        activeSource = null;
        providerCapabilities = null;
        byId('sourceName').value = '我的 ZBoard';
        byId('providerOrigin').value = '';
        setNetworkPath('direct');
        setSyncInterval(900);
        notice('');
        showView('source');
      });
      byId('syncNow').addEventListener('click', () => runRequest('syncNow', async () => {
        notice('');
        try {
          const binding = await sourceStateGet('subscription/binding');
          if (!binding?.remote_subscription_id) throw new Error('当前没有已关联的订阅。');
          await loadCapabilities();
          const result = await pullSubscription(binding.remote_subscription_id, binding.name, {force: true});
          const messageResult = await synchronizeMessages();
          const syncMessage = result.usageError
            ? `订阅配置已同步，但流量信息更新失败：${result.usageError}`
            : result.notModified ? '订阅已经是最新版本。' : '订阅和消息已同步。';
          notice(messageResult.notificationFailed
            ? `${syncMessage.replace(/。$/u, '')}；新消息已同步，但系统提醒未送达，请查看客户端日志或系统通知设置。`
            : syncMessage,
          result.usageError || messageResult.notificationFailed ? 'warning' : 'success');
        } catch (error) {
          notice(connectFailure(error), 'error');
        }
      }));
      byId('removeSource').addEventListener('click', () => runRequest('removeSource', async () => {
        if (!activeSource) return;
        await removeSourceRecord(activeSource);
      }));

      byId('closeMessage').addEventListener('click', () => byId('messageDialog').close());
      byId('messageDialog').addEventListener('click', event => {
        if (event.target === byId('messageDialog')) byId('messageDialog').close();
      });

      for (const option of document.querySelectorAll('[data-sync-interval]')) {
        option.addEventListener('click', () => setSyncInterval(Number(option.dataset.syncInterval)));
        option.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const options = [...document.querySelectorAll('[data-sync-interval]')];
          const next = options[(options.indexOf(option) + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + options.length) % options.length];
          next.click(); next.focus();
        });
      }

      byId('networkPath').addEventListener('click', () => {
        const open = byId('networkPath').getAttribute('aria-expanded') !== 'true';
        setNetworkPathOpen(open, open);
      });
      byId('networkPath').addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        setNetworkPathOpen(true, true);
      });
      for (const option of networkPathOptions()) {
        option.addEventListener('click', () => {
          setNetworkPath(option.dataset.value);
          setNetworkPathOpen(false);
          byId('networkPath').focus();
        });
        option.addEventListener('keydown', event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            focusNetworkPathOption(event.key === 'ArrowDown' ? 1 : -1);
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            const options = networkPathOptions();
            options[event.key === 'Home' ? 0 : options.length - 1].focus();
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            option.click();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setNetworkPathOpen(false);
            byId('networkPath').focus();
          } else if (event.key === 'Tab') {
            setNetworkPathOpen(false);
          }
        });
      }
      document.addEventListener('pointerdown', event => {
        if (!event.target.closest('[data-znet-select]')) setNetworkPathOpen(false);
      });

      byId('login').addEventListener('click', () => runRequest('login', async () => {
        notice('');
        const password = byId('password').value;
        try {
          const result = await invoke('authorization.password', {account: byId('account').value.trim(), password});
          notice(result.message, result.ok ? 'success' : 'error');
          if (result.ok) showView('subscriptions');
        } catch (error) {
          notice(connectFailure(error), 'error');
        } finally {
          byId('password').value = '';
        }
      }));

      byId('bindSubscription').addEventListener('click', () => runRequest('bindSubscription', async () => {
        notice('');
        try {
          const selected = availableSubscriptions.find(item => item.subscription_id === selectedSubscriptionId);
          if (!selected) throw new Error('请选择一个订阅。');
          const result = await selectSubscription(selected);
          await synchronizeMessages().catch(() => {});
          notice(result.removalError
            ? `新订阅已关联，但旧订阅移除失败：${result.removalError}；下次打开连接时会重试。`
            : result.usageError
            ? `订阅已关联，但流量信息暂未更新：${result.usageError}`
            : '订阅已交给客户端托管。', result.usageError || result.removalError ? 'warning' : 'success');
          showView('complete');
          await refreshAccountProfile();
        } catch (error) {
          notice(connectFailure(error), 'error');
        }
      }));

      for (const button of document.querySelectorAll('[data-open-diagnostics]')) {
        button.addEventListener('click', () => { diagnosticsReturnView = currentView; notice(''); showView('diagnostics'); });
      }
      byId('closeDiagnostics').addEventListener('click', () => showView(diagnosticsReturnView));
      byId('diagnose').addEventListener('click', () => runRequest('diagnose', async () => {
        try {
          const value = await invoke('diagnostics.run');
          byId('diagnostics').textContent = JSON.stringify(value, null, 2);
          render(value);
        } catch (error) {
          notice(error.message || '诊断失败', 'error');
        }
      }));
      byId('resetLocal').addEventListener('click', () => runRequest('resetLocal', async () => {
        if (!confirm('确定清除本机的 Connect 信任、设备密钥和会话凭据吗？已生成的客户端订阅不会自动删除。')) return;
        await clearActiveSourceRuntime(false);
        providerCapabilities = null; availableSubscriptions = []; selectedSubscriptionId = null;
        notice('本机 Connect 关联已清除，可重新验证服务并授权设备。', 'success');
        showView('source');
      }));

      (async () => {
        try {
          const stored = await stateGet('sources/index');
          sources = Array.isArray(stored) ? stored : [];
          validateSources(sources);
          renderSourceList();
          showView('sources');
          const config = await znetPlugin.configuration.get(component);
          if (!sources.length && config.provider_origin) {
            const legacyIdentity = await stateGet('device/identity');
            const source = {
              id: legacyIdentity?.source_id || `source-${bytesToHex(randomBytes(16))}`,
              name: config.source_name || '我的 ZBoard',
              origin: new URL(config.provider_origin).origin,
              network_path: config.network_path || 'direct',
              device_key_name: 'connect-device',
            };
            activeSource = source;
            for (const key of ['device/identity', 'session/metadata', 'subscription/binding', 'messages/summary']) {
              const value = await stateGet(key);
              if (value != null) await sourceStatePut(key, value);
            }
            for (const key of ['trust/provider', 'session/access', 'session/renewal']) {
              const value = await secretGet(key);
              if (value != null) await secretPut(sourceSecretKey(key), value);
            }
            sources = [source];
            await saveSources(sources, true);
            await sdk('tasks.schedule', 'self', 'schedule_delete', {taskId: 'connect-sync'}, 65536).catch(() => {});
          } else if (!config.provider_origins || config.provider_origins !== JSON.stringify([...new Set(sources.map(source => source.origin))])) {
            await saveSources(sources, true);
          }
        } catch (error) {
          notice(sources.length
            ? `读取来源配置时出错：${error.message || '无法读取已有设置'}。已保留本机来源，可重试或继续管理。`
            : `${error.message || '无法读取已有设置'}；可以直接重新填写并保存。`, 'error');
        }
        renderSourceList();
        showView('sources');
        if (initialNavigation?.route?.startsWith('messages.') && initialNavigation.reference) {
          const sourceId = initialNavigation.route.slice('messages.'.length);
          const source = sources.find(item => item.id === sourceId);
          if (source) {
            await selectSource(source);
            await openActiveSource();
            await synchronizeMessages(false).catch(error => notice(error.message || '无法刷新消息', 'error'));
            await openMessage(initialNavigation.reference);
          }
        } else if (initialNavigation?.route?.startsWith('authorization.')) {
          const source = sources.find(item => item.id === initialNavigation.route.slice('authorization.'.length));
          if (source) {
            await selectSource(source);
            await refreshStatus();
            showView('account');
          }
        }
      })();
    })();
