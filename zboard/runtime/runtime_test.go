package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	protocolv1 "github.com/zerodenet/connect/protocol/v1"
	pluginv1 "github.com/zerodenet/zboard/backend/pkg/pluginapi/v1"
)

type memoryStorageBackend struct {
	mu       sync.Mutex
	revision uint64
	values   map[string]json.RawMessage
}

type memoryStorage struct{ backend *memoryStorageBackend }

func (storage *memoryStorage) Get(_ context.Context, key string) (pluginv1.StoredValue, error) {
	storage.backend.mu.Lock()
	defer storage.backend.mu.Unlock()
	value, found := storage.backend.values[key]
	return pluginv1.StoredValue{Revision: storage.backend.revision, Found: found, Value: append(json.RawMessage(nil), value...)}, nil
}

func (storage *memoryStorage) Put(_ context.Context, key string, revision uint64, value json.RawMessage) (pluginv1.StoredValue, error) {
	storage.backend.mu.Lock()
	defer storage.backend.mu.Unlock()
	if revision != storage.backend.revision {
		return pluginv1.StoredValue{}, errors.New("revision conflict")
	}
	storage.backend.revision++
	storage.backend.values[key] = append(json.RawMessage(nil), value...)
	return pluginv1.StoredValue{Revision: storage.backend.revision, Found: true, Value: value}, nil
}

func (storage *memoryStorage) Delete(_ context.Context, key string, revision uint64) (pluginv1.StoredValue, error) {
	storage.backend.mu.Lock()
	defer storage.backend.mu.Unlock()
	if revision != storage.backend.revision {
		return pluginv1.StoredValue{}, errors.New("revision conflict")
	}
	storage.backend.revision++
	delete(storage.backend.values, key)
	return pluginv1.StoredValue{Revision: storage.backend.revision}, nil
}

func (*memoryStorage) Close() {}

type fakeHost struct {
	mu           sync.Mutex
	accountCalls int
}

func (*fakeHost) Close() {}

func (host *fakeHost) Call(_ context.Context, capability, operation string, payload any, out any) error {
	host.mu.Lock()
	defer host.mu.Unlock()
	var value any
	switch capability + "/" + operation {
	case pluginv1.AccountAssertionCapability + "/account.assert":
		host.accountCalls++
		request := payload.(pluginv1.AccountAssertionRequest)
		if request.Account != "user@example.com" || request.Password != "correct horse" {
			return &pluginv1.HostCallError{Code: "invalid_credentials"}
		}
		value = pluginv1.Principal{ID: "42", Display: "User", Admin: true}
	case pluginv1.SubscriptionProjectionCapability + "/subscriptions.list":
		value = []pluginv1.ProjectedSubscription{{ID: "7", DisplayName: "Pro", Format: subscriptionFormat, Revision: "r1", ContentSHA256: "abc", UpdatedAt: 1}}
	case pluginv1.SubscriptionProjectionCapability + "/subscriptions.get":
		request := payload.(pluginv1.SubscriptionContentRequest)
		value = pluginv1.ProjectedSubscription{ID: request.SubscriptionID, DisplayName: "Pro", Format: request.Format, Revision: "r1", ContentSHA256: "abc", UpdatedAt: 1, Content: `{"version":1}`}
	case pluginv1.MessageProjectionCapability + "/messages.list":
		value = pluginv1.MessagePage{Items: []pluginv1.ProjectedMessage{{ID: "9", Title: "Notice", Severity: "info", Revision: 3, PublishedAt: 2}}, NextCursor: "8"}
	case pluginv1.MessageProjectionCapability + "/messages.get":
		value = pluginv1.ProjectedMessage{ID: "9", Title: "Notice", Body: "Hello", Severity: "info", Revision: 3, PublishedAt: 2}
	case pluginv1.MessageProjectionCapability + "/messages.mark-read":
		request := payload.(pluginv1.MessageMarkReadRequest)
		if request.Revision != 3 {
			return &pluginv1.HostCallError{Code: "conflict"}
		}
		value = map[string]any{"message_id": request.MessageID, "read_at": int64(4)}
	default:
		return &pluginv1.HostCallError{Code: "not_found"}
	}
	raw, _ := json.Marshal(value)
	return json.Unmarshal(raw, out)
}

type testClient struct {
	devicePrivate  ed25519.PrivateKey
	deviceID       string
	sourceID       string
	providerKeyID  string
	providerPublic []byte
}

type sealedCall struct {
	request         *pluginv1.HTTPRequest
	responsePrivate []byte
	operation       string
}

func TestProviderRuntimeAuthorizationProjectionRenewalAndReplay(t *testing.T) {
	backend := &memoryStorageBackend{values: map[string]json.RawMessage{}}
	host := &fakeHost{}
	runtime := newRuntime()
	runtime.openStorage = func() (storageClient, error) { return &memoryStorage{backend: backend}, nil }
	runtime.openHost = func() (hostClient, error) { return host, nil }
	configRaw := []byte(`{"enabled":true,"provider_id":"https://panel.example","display_name":"Example"}`)
	if _, err := runtime.ApplyConfig(context.Background(), &pluginv1.ConfigRequest{ConfigJson: configRaw}); err != nil {
		t.Fatal(err)
	}

	discoveryResponse, err := runtime.HandleHTTP(context.Background(), &pluginv1.HTTPRequest{RouteId: "capabilities", Method: "GET"})
	if err != nil || discoveryResponse.Status != 200 {
		t.Fatalf("discovery: %v %#v", err, discoveryResponse)
	}
	var discovery struct {
		ProviderKey       protocolv1.ProviderKeyStatement `json:"provider_key_statement"`
		IdentityPublicKey string                          `json:"identity_public_key"`
	}
	if err := json.Unmarshal(discoveryResponse.Body, &discovery); err != nil {
		t.Fatal(err)
	}
	identityPublic, _ := base64.RawURLEncoding.DecodeString(discovery.IdentityPublicKey)
	if err := discovery.ProviderKey.Verify(ed25519.PublicKey(identityPublic), time.Now()); err != nil {
		t.Fatal(err)
	}
	providerPublic, _ := base64.RawURLEncoding.DecodeString(discovery.ProviderKey.HPKEPublicKey)
	_, devicePrivate, _ := ed25519.GenerateKey(rand.Reader)
	client := testClient{devicePrivate: devicePrivate, deviceID: "device-1", sourceID: "source-1", providerKeyID: discovery.ProviderKey.KeyID, providerPublic: providerPublic}

	passwordCall := client.seal(t, "authorization.password", protocolv1.Authorization{Kind: "password", Credential: "correct horse"}, map[string]any{"account": "user@example.com", "device_name": "Laptop"})
	passwordRaw := callHTTP(t, runtime, passwordCall)
	password := openCall(t, client, passwordCall, passwordRaw)
	if password.Status != "ok" {
		t.Fatalf("password response: %#v", password)
	}
	var credentials struct {
		Access  string `json:"access_credential"`
		Renewal string `json:"renewal_credential"`
	}
	if err := json.Unmarshal(password.Body, &credentials); err != nil {
		t.Fatal(err)
	}
	if credentials.Access == "" || credentials.Renewal == "" {
		t.Fatal("missing credentials")
	}
	replayedRaw := callHTTP(t, runtime, passwordCall)
	if !bytes.Equal(passwordRaw, replayedRaw) || host.accountCalls != 1 {
		t.Fatal("password replay did not return the exact cached response")
	}

	listCall := client.seal(t, "subscriptions.list", protocolv1.Authorization{Kind: "access", Credential: credentials.Access}, map[string]any{})
	listRaw := callHTTP(t, runtime, listCall)
	list := openCall(t, client, listCall, listRaw)
	if list.Status != "ok" || !bytes.Contains(list.Body, []byte(`"subscription_id"`)) && !bytes.Contains(list.Body, []byte(`"subscriptions"`)) {
		t.Fatalf("subscription list: %s", list.Body)
	}
	if !bytes.Equal(listRaw, callHTTP(t, runtime, listCall)) {
		t.Fatal("safe replay was not byte-identical")
	}
	contentCall := client.seal(t, "subscriptions.get-content", protocolv1.Authorization{Kind: "access", Credential: credentials.Access}, map[string]any{"subscription_id": "7", "known_revision": nil})
	content := openCall(t, client, contentCall, callHTTP(t, runtime, contentCall))
	if content.Status != "ok" || !bytes.Contains(content.Body, []byte(`"subscription_id":"7"`)) || !bytes.Contains(content.Body, []byte(`"content"`)) {
		t.Fatalf("subscription content: %#v", content)
	}
	messageListCall := client.seal(t, "messages.list", protocolv1.Authorization{Kind: "access", Credential: credentials.Access}, map[string]any{"cursor": nil, "limit": 20})
	messageList := openCall(t, client, messageListCall, callHTTP(t, runtime, messageListCall))
	if messageList.Status != "ok" || !bytes.Contains(messageList.Body, []byte(`"message_id":"9"`)) {
		t.Fatalf("message list: %#v", messageList)
	}
	messageGetCall := client.seal(t, "messages.get", protocolv1.Authorization{Kind: "access", Credential: credentials.Access}, map[string]any{"message_id": "9"})
	messageGet := openCall(t, client, messageGetCall, callHTTP(t, runtime, messageGetCall))
	if messageGet.Status != "ok" || !bytes.Contains(messageGet.Body, []byte(`"body":"Hello"`)) {
		t.Fatalf("message get: %#v", messageGet)
	}
	markReadCall := client.seal(t, "messages.mark-read", protocolv1.Authorization{Kind: "access", Credential: credentials.Access}, map[string]any{"message_id": "9"})
	markRead := openCall(t, client, markReadCall, callHTTP(t, runtime, markReadCall))
	if markRead.Status != "ok" || !bytes.Contains(markRead.Body, []byte(`"read_at":4`)) {
		t.Fatalf("message mark read: %#v", markRead)
	}

	renewCall := client.seal(t, "authorization.renew", protocolv1.Authorization{Kind: "renewal", Credential: credentials.Renewal}, map[string]any{})
	renewRaw := callHTTP(t, runtime, renewCall)
	renew := openCall(t, client, renewCall, renewRaw)
	if renew.Status != "ok" {
		t.Fatalf("renew response: %#v", renew)
	}
	var renewed struct {
		Access string `json:"access_credential"`
	}
	if err := json.Unmarshal(renew.Body, &renewed); err != nil || renewed.Access == "" {
		t.Fatalf("renewed credentials: %v %#v", err, renewed)
	}
	if !bytes.Equal(renewRaw, callHTTP(t, runtime, renewCall)) {
		t.Fatal("renewal recovery response changed")
	}

	oldRenewalCall := client.seal(t, "authorization.renew", protocolv1.Authorization{Kind: "renewal", Credential: credentials.Renewal}, map[string]any{})
	oldRenewal := openCall(t, client, oldRenewalCall, callHTTP(t, runtime, oldRenewalCall))
	if oldRenewal.Status != "error" || oldRenewal.Error == nil || oldRenewal.Error.Code != "reauthorization_required" {
		t.Fatalf("old renewal credential was accepted: %#v", oldRenewal)
	}
	page, err := runtime.HandlePageAction(context.Background(), &pluginv1.PageActionRequest{
		PageId: "authorized-devices", Surface: "account", ActorId: "42", Action: "devices.list", PayloadJson: []byte(`{}`),
	})
	if err != nil || !bytes.Contains(page.ResultJson, []byte(`"device_id":"device-1"`)) {
		t.Fatalf("page device list: %v %s", err, page.ResultJson)
	}
	page, err = runtime.HandlePageAction(context.Background(), &pluginv1.PageActionRequest{
		PageId: "authorized-devices", Surface: "account", ActorId: "42", Action: "devices.revoke", PayloadJson: []byte(`{"device_id":"device-1"}`),
	})
	if err != nil || !bytes.Contains(page.ResultJson, []byte(`"revoked":true`)) {
		t.Fatalf("page revoke: %v %s", err, page.ResultJson)
	}
	afterRevokeCall := client.seal(t, "subscriptions.list", protocolv1.Authorization{Kind: "access", Credential: renewed.Access}, map[string]any{})
	afterRevoke := openCall(t, client, afterRevokeCall, callHTTP(t, runtime, afterRevokeCall))
	if afterRevoke.Status != "error" || afterRevoke.Error == nil || afterRevoke.Error.Code != "unauthorized" {
		t.Fatalf("revoked device retained access: %#v", afterRevoke)
	}
	safeReplayCount := 0
	for key := range backend.values {
		if strings.HasPrefix(key, "replay-") {
			safeReplayCount++
		}
	}
	if safeReplayCount > maxSafeReplayRecords {
		t.Fatalf("safe replay storage exceeded its bounded window: %d", safeReplayCount)
	}
}

func (client testClient) seal(t *testing.T, operation string, authorization protocolv1.Authorization, body any) sealedCall {
	t.Helper()
	responsePublic, responsePrivate, err := protocolv1.GenerateHPKEKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	bodyRaw, _ := json.Marshal(body)
	requestIDBytes := make([]byte, 16)
	if _, err := rand.Read(requestIDBytes); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	message := protocolv1.RequestMessage{
		ProtocolVersion: protocolv1.ProtocolVersion, Operation: operation,
		RequestID: base64.RawURLEncoding.EncodeToString(requestIDBytes), IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix(),
		SourceID: client.sourceID, DeviceID: client.deviceID, ResponsePublicKey: base64.RawURLEncoding.EncodeToString(responsePublic),
		Authorization: authorization, Body: bodyRaw,
	}
	envelope, err := protocolv1.SealRequestMessage(client.providerPublic, client.providerKeyID, message, client.devicePrivate)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(envelope)
	return sealedCall{request: &pluginv1.HTTPRequest{RouteId: "exchange", Method: "POST", ContentType: "application/json", Body: raw}, responsePrivate: responsePrivate, operation: operation}
}

func callHTTP(t *testing.T, runtime *connectRuntime, call sealedCall) []byte {
	t.Helper()
	response, err := runtime.HandleHTTP(context.Background(), call.request)
	if err != nil || response.Status != 200 {
		t.Fatalf("HTTP exchange: %v %#v", err, response)
	}
	return append([]byte(nil), response.Body...)
}

func openCall(t *testing.T, client testClient, call sealedCall, raw []byte) protocolv1.ResponseMessage {
	t.Helper()
	envelope, err := protocolv1.DecodeResponseEnvelope(raw)
	if err != nil {
		t.Fatal(err)
	}
	message, err := protocolv1.OpenResponseMessage(call.responsePrivate, client.providerPublic, envelope, time.Now(), call.operation)
	if err != nil {
		t.Fatal(err)
	}
	return message
}

func TestConfigRejectsNonOriginAndUnknownFields(t *testing.T) {
	for _, raw := range [][]byte{
		[]byte(`{"enabled":true,"provider_id":"http://panel.example"}`),
		[]byte(`{"enabled":true,"provider_id":"https://panel.example/path"}`),
		[]byte(`{"enabled":true,"provider_id":"https://panel.example","extra":true}`),
	} {
		if _, _, err := normalizeConfig(raw); err == nil {
			t.Fatalf("accepted invalid config %s", raw)
		}
	}
	valid, _, err := normalizeConfig([]byte(`{"enabled":true,"provider_id":"https://panel.example"}`))
	if err != nil || !reflect.DeepEqual(valid, runtimeConfig{Enabled: true, ProviderID: "https://panel.example", DisplayName: "ZBoard"}) {
		t.Fatalf("valid config: %#v %v", valid, err)
	}
}
