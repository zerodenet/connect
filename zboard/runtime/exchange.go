package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	protocolv1 "github.com/zerodenet/connect/protocol/v1"
	pluginv1 "github.com/zerodenet/zboard/backend/pkg/pluginapi/v1"
)

const replayRetention = 5 * time.Minute
const maxEnvelopeBytes = (protocolv1.MaxPlaintext+16)*4/3 + 4096
const maxSafeReplayRecords = 4

func (runtime *connectRuntime) HandleHTTP(ctx context.Context, request *pluginv1.HTTPRequest) (*pluginv1.HTTPResponse, error) {
	config := runtime.currentConfig()
	if !config.Enabled {
		return jsonResponse(503, map[string]string{"error": "communication_disabled"}), nil
	}
	switch request.GetRouteId() {
	case "capabilities":
		if request.GetMethod() != "GET" || len(request.GetBody()) != 0 {
			return jsonResponse(400, map[string]string{"error": "invalid_request"}), nil
		}
		return runtime.handleCapabilities(ctx, config)
	case "exchange":
		if request.GetMethod() != "POST" || mediaType(request.GetContentType()) != "application/json" {
			return jsonResponse(400, map[string]string{"error": "invalid_request"}), nil
		}
		return runtime.handleExchange(ctx, config, request.GetBody())
	default:
		return jsonResponse(404, map[string]string{"error": "not_found"}), nil
	}
}

func (runtime *connectRuntime) handleCapabilities(ctx context.Context, config runtimeConfig) (*pluginv1.HTTPResponse, error) {
	runtime.opMu.Lock()
	defer runtime.opMu.Unlock()
	storage, err := runtime.openStorage()
	if err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	defer storage.Close()
	loaded, err := loadProviderState(ctx, storage, config.ProviderID, time.Now().UTC())
	if err != nil {
		return jsonResponse(503, map[string]string{"error": providerStateError(err)}), nil
	}
	identityPublic, _ := decodeBytes(loaded.value.IdentityPublicKey, ed25519.PublicKeySize)
	fingerprint, err := protocolv1.IdentityFingerprint(ed25519.PublicKey(identityPublic))
	if err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	contract, err := protocolv1.Load()
	if err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	operations := make([]string, 0, len(contract.Operations))
	for _, operation := range contract.Operations {
		operations = append(operations, operation.ID)
	}
	return jsonResponse(200, map[string]any{
		"protocol_version":       protocolv1.ProtocolVersion,
		"provider_id":            config.ProviderID,
		"display_name":           config.DisplayName,
		"identity_key_id":        loaded.value.IdentityKeyID,
		"identity_public_key":    loaded.value.IdentityPublicKey,
		"identity_fingerprint":   fingerprint,
		"provider_key_statement": loaded.value.ProviderKeyStatement,
		"exchange_path":          "/.well-known/zerodenet-connect/v1/exchange",
		"operations":             operations,
	}), nil
}

func (runtime *connectRuntime) handleExchange(ctx context.Context, config runtimeConfig, raw []byte) (*pluginv1.HTTPResponse, error) {
	if len(raw) == 0 || len(raw) > maxEnvelopeBytes {
		return jsonResponse(400, map[string]string{"error": "invalid_request"}), nil
	}
	envelope, err := protocolv1.DecodeRequestEnvelope(raw)
	if err != nil {
		return jsonResponse(400, map[string]string{"error": "invalid_request"}), nil
	}
	runtime.opMu.Lock()
	defer runtime.opMu.Unlock()
	storage, err := runtime.openStorage()
	if err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	defer storage.Close()
	now := time.Now().UTC()
	loaded, err := loadProviderState(ctx, storage, config.ProviderID, now)
	if err != nil {
		return jsonResponse(503, map[string]string{"error": providerStateError(err)}), nil
	}
	providerKey, ok := loaded.value.responseKey(envelope.KeyID, now)
	if !ok {
		return jsonResponse(409, map[string]string{"error": "trust_mismatch"}), nil
	}
	message, err := protocolv1.OpenRequestMessage(providerKey.Private, envelope, now)
	if err != nil {
		return jsonResponse(400, map[string]string{"error": "invalid_request"}), nil
	}
	responsePublicKey, err := decodeBytes(message.ResponsePublicKey, 32)
	if err != nil {
		return jsonResponse(400, map[string]string{"error": "invalid_request"}), nil
	}
	requestDigest := sha256.Sum256(raw)
	requestHash := hex.EncodeToString(requestDigest[:])
	retainUntil := message.ExpiresAt + int64(replayRetention/time.Second)
	if loaded.value.prune(now) {
		if err := loaded.save(ctx, storage); err != nil {
			return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
		}
	}
	if err := runtime.pruneSafeReplays(ctx, storage, &loaded, now); err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}

	if isSafeOperation(message.Operation) {
		return runtime.executeSafe(ctx, storage, &loaded, providerKey, message, requestHash, retainUntil, responsePublicKey, now)
	}
	return runtime.executeMutation(ctx, storage, &loaded, providerKey, message, requestHash, retainUntil, responsePublicKey, now)
}

func (runtime *connectRuntime) executeMutation(ctx context.Context, storage storageClient, loaded *loadedState, providerKey responseKey, message protocolv1.RequestMessage, requestHash string, retainUntil int64, responsePublicKey []byte, now time.Time) (*pluginv1.HTTPResponse, error) {
	key := mutationReplayKey(providerKey.ID, message.RequestID)
	if replay, ok := loaded.value.MutationReplays[key]; ok {
		if replay.RequestHash != requestHash {
			return runtime.encryptedError(providerKey, message, responsePublicKey, "replay_rejected", now)
		}
		if len(replay.Response) != 0 {
			return &pluginv1.HTTPResponse{Status: 200, ContentType: "application/json", Body: replay.Response}, nil
		}
	} else {
		loaded.value.MutationReplays[key] = replayRecord{RequestHash: requestHash, RetainUntil: retainUntil}
		if err := loaded.save(ctx, storage); err != nil {
			return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
		}
	}
	body, code := runtime.dispatch(ctx, &loaded.value, message, now)
	response, raw, err := runtime.sealResult(providerKey, message, responsePublicKey, body, code, now)
	if err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	replay := loaded.value.MutationReplays[key]
	replay.Response = raw
	loaded.value.MutationReplays[key] = replay
	if err := loaded.save(ctx, storage); err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	return response, nil
}

func (runtime *connectRuntime) executeSafe(ctx context.Context, storage storageClient, loaded *loadedState, providerKey responseKey, message protocolv1.RequestMessage, requestHash string, retainUntil int64, responsePublicKey []byte, now time.Time) (*pluginv1.HTTPResponse, error) {
	key := safeReplayStorageKey(providerKey.ID, message.RequestID)
	stored, err := storage.Get(ctx, key)
	if err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	loaded.revision = stored.Revision
	if stored.Found {
		var replay replayRecord
		if json.Unmarshal(stored.Value, &replay) != nil || replay.RequestHash == "" {
			return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
		}
		if replay.RequestHash != requestHash {
			return runtime.encryptedError(providerKey, message, responsePublicKey, "replay_rejected", now)
		}
		if len(replay.Response) != 0 {
			return &pluginv1.HTTPResponse{Status: 200, ContentType: "application/json", Body: replay.Response}, nil
		}
	} else {
		if len(loaded.value.SafeReplays) >= maxSafeReplayRecords {
			oldestKey := ""
			var oldestUntil int64
			for candidate, until := range loaded.value.SafeReplays {
				if oldestKey == "" || until < oldestUntil {
					oldestKey, oldestUntil = candidate, until
				}
			}
			if oldestKey != "" {
				result, err := storage.Delete(ctx, oldestKey, loaded.revision)
				if err != nil {
					return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
				}
				loaded.revision = result.Revision
				delete(loaded.value.SafeReplays, oldestKey)
			}
		}
		loaded.value.SafeReplays[key] = retainUntil
		if err := loaded.save(ctx, storage); err != nil {
			return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
		}
		pending, _ := json.Marshal(replayRecord{RequestHash: requestHash, RetainUntil: retainUntil})
		result, err := storage.Put(ctx, key, loaded.revision, pending)
		if err != nil {
			return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
		}
		loaded.revision = result.Revision
	}
	body, code := runtime.dispatch(ctx, &loaded.value, message, now)
	response, raw, err := runtime.sealResult(providerKey, message, responsePublicKey, body, code, now)
	if err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	completed, _ := json.Marshal(replayRecord{RequestHash: requestHash, Response: raw, RetainUntil: retainUntil})
	result, err := storage.Put(ctx, key, loaded.revision, completed)
	if err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	loaded.revision = result.Revision
	return response, nil
}

func (runtime *connectRuntime) encryptedError(providerKey responseKey, request protocolv1.RequestMessage, responsePublicKey []byte, code string, now time.Time) (*pluginv1.HTTPResponse, error) {
	response, _, err := runtime.sealResult(providerKey, request, responsePublicKey, nil, code, now)
	if err != nil {
		return jsonResponse(503, map[string]string{"error": "temporary_unavailable"}), nil
	}
	return response, nil
}

func (runtime *connectRuntime) sealResult(providerKey responseKey, request protocolv1.RequestMessage, responsePublicKey []byte, body json.RawMessage, code string, now time.Time) (*pluginv1.HTTPResponse, json.RawMessage, error) {
	message := protocolv1.ResponseMessage{
		ProtocolVersion: protocolv1.ProtocolVersion, Operation: request.Operation, RequestID: request.RequestID,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(protocolv1.MaxRequestLifetime).Unix(), Status: "ok", Body: body,
	}
	if code != "" {
		message.Status = "error"
		message.Body = nil
		message.Error = &protocolv1.ResponseError{Code: code}
	}
	envelope, err := protocolv1.SealResponseMessage(providerKey.Private, responsePublicKey, providerKey.ID, message)
	if err != nil {
		return nil, nil, err
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return nil, nil, err
	}
	return &pluginv1.HTTPResponse{Status: 200, ContentType: "application/json", Body: raw}, raw, nil
}

func (runtime *connectRuntime) pruneSafeReplays(ctx context.Context, storage storageClient, loaded *loadedState, now time.Time) error {
	changed := false
	for key, retainUntil := range loaded.value.SafeReplays {
		if retainUntil > now.Unix() {
			continue
		}
		result, err := storage.Delete(ctx, key, loaded.revision)
		if err != nil {
			return err
		}
		loaded.revision = result.Revision
		delete(loaded.value.SafeReplays, key)
		changed = true
	}
	if changed {
		return loaded.save(ctx, storage)
	}
	return nil
}

func isSafeOperation(operation string) bool {
	switch operation {
	case "devices.list", "subscriptions.list", "subscriptions.get-content", "messages.list", "messages.get":
		return true
	default:
		return false
	}
}

func providerStateError(err error) string {
	if errors.Is(err, errProviderIDChanged) {
		return "trust_mismatch"
	}
	return "temporary_unavailable"
}

func mediaType(value string) string {
	return strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
}
