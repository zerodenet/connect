//go:build zboard_connect_installed_acceptance

package plugins

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	protocolv1 "github.com/zerodenet/connect/protocol/v1"
	pluginv1 "github.com/zerodenet/zboard/backend/pkg/pluginapi/v1"
)

const (
	connectPluginID       = "org.zerodenet.connect.zboard"
	connectCapabilities   = "/.well-known/zerodenet-connect/v1/capabilities"
	connectExchange       = "/.well-known/zerodenet-connect/v1/exchange"
	connectProviderOrigin = "https://panel.example"
)

type connectAcceptanceHost struct {
	t              *testing.T
	accountCalls   int
	messageRead    bool
	subscriptionID string
}

func (host *connectAcceptanceHost) CallPluginHost(_ context.Context, pluginID, capability, operation string, payload json.RawMessage) (json.RawMessage, *pluginv1.HostCallError) {
	host.t.Helper()
	if pluginID != connectPluginID {
		host.t.Fatalf("host call escaped installed plugin identity: %q", pluginID)
	}
	encode := func(value any) (json.RawMessage, *pluginv1.HostCallError) {
		raw, err := json.Marshal(value)
		if err != nil {
			host.t.Fatal(err)
		}
		return raw, nil
	}
	badPayload := func() (json.RawMessage, *pluginv1.HostCallError) {
		return nil, &pluginv1.HostCallError{Code: "invalid_request", Message: "invalid host payload"}
	}

	switch capability + "/" + operation {
	case pluginv1.AccountAssertionCapability + "/account.assert":
		var request pluginv1.AccountAssertionRequest
		if json.Unmarshal(payload, &request) != nil {
			return badPayload()
		}
		host.accountCalls++
		if request.Account != "user@example.com" || request.Password != "correct horse" {
			return nil, &pluginv1.HostCallError{Code: "invalid_credentials"}
		}
		return encode(pluginv1.Principal{ID: "42", Display: "User", Admin: true})

	case pluginv1.SubscriptionProjectionCapability + "/subscriptions.list":
		var request pluginv1.SubscriptionListRequest
		if json.Unmarshal(payload, &request) != nil || request.PrincipalID != "42" || request.Format != "znet-sink" {
			return badPayload()
		}
		content := "version: 1\nproxies: []\n"
		digest := sha256.Sum256([]byte(content))
		return encode([]pluginv1.ProjectedSubscription{{
			ID: host.subscriptionID, DisplayName: "Pro", Format: request.Format,
			Revision: "r1", ContentSHA256: hex.EncodeToString(digest[:]), UpdatedAt: 1,
		}})

	case pluginv1.SubscriptionProjectionCapability + "/subscriptions.get":
		var request pluginv1.SubscriptionContentRequest
		if json.Unmarshal(payload, &request) != nil || request.PrincipalID != "42" || request.SubscriptionID != host.subscriptionID || request.Format != "znet-sink" {
			return badPayload()
		}
		content := "version: 1\nproxies: []\n"
		digest := sha256.Sum256([]byte(content))
		if request.KnownRevision == "r1" {
			return encode(pluginv1.ProjectedSubscription{
				ID: request.SubscriptionID, DisplayName: "Pro", Format: request.Format,
				Revision: "r1", ContentSHA256: hex.EncodeToString(digest[:]), UpdatedAt: 1, NotModified: true,
			})
		}
		return encode(pluginv1.ProjectedSubscription{
			ID: request.SubscriptionID, DisplayName: "Pro", Format: request.Format,
			Revision: "r1", ContentSHA256: hex.EncodeToString(digest[:]), UpdatedAt: 1, Content: content,
		})

	case pluginv1.MessageProjectionCapability + "/messages.list":
		var request pluginv1.MessageListRequest
		if json.Unmarshal(payload, &request) != nil || request.PrincipalID != "42" || request.Limit != 20 {
			return badPayload()
		}
		return encode(pluginv1.MessagePage{Items: []pluginv1.ProjectedMessage{{
			ID: "9", Title: "Notice", Severity: "info", Revision: 3, PublishedAt: 2,
		}}, NextCursor: "8"})

	case pluginv1.MessageProjectionCapability + "/messages.get":
		var request pluginv1.MessageGetRequest
		if json.Unmarshal(payload, &request) != nil || request.PrincipalID != "42" || request.MessageID != "9" {
			return badPayload()
		}
		readAt := int64(0)
		if host.messageRead {
			readAt = 4
		}
		return encode(pluginv1.ProjectedMessage{
			ID: "9", Title: "Notice", Body: "Hello", Severity: "info", Revision: 3,
			PublishedAt: 2, ReadAt: readAt,
		})

	case pluginv1.MessageProjectionCapability + "/messages.mark-read":
		var request pluginv1.MessageMarkReadRequest
		if json.Unmarshal(payload, &request) != nil || request.PrincipalID != "42" || request.MessageID != "9" || request.Revision != 3 {
			return badPayload()
		}
		host.messageRead = true
		return encode(map[string]any{"message_id": request.MessageID, "read_at": int64(4)})
	default:
		return nil, &pluginv1.HostCallError{Code: "not_found"}
	}
}

type connectAcceptanceClient struct {
	devicePrivate  ed25519.PrivateKey
	providerKeyID  string
	providerPublic []byte
}

type connectAcceptanceDiscovery struct {
	ProviderID          string                          `json:"provider_id"`
	IdentityKeyID       string                          `json:"identity_key_id"`
	IdentityPublicKey   string                          `json:"identity_public_key"`
	IdentityFingerprint string                          `json:"identity_fingerprint"`
	ProviderKey         protocolv1.ProviderKeyStatement `json:"provider_key_statement"`
}

type connectAcceptanceSealedCall struct {
	raw             []byte
	responsePrivate []byte
	operation       string
}

func TestConnectInstalledHostEndToEnd(t *testing.T) {
	packagePath := os.Getenv("CONNECT_ZBOARD_PACKAGE")
	publicKey := os.Getenv("CONNECT_PUBLISHER_PUBLIC_KEY")
	if packagePath == "" || publicKey == "" {
		t.Fatal("CONNECT_ZBOARD_PACKAGE and CONNECT_PUBLISHER_PUBLIC_KEY are required")
	}
	packageBytes, err := os.ReadFile(packagePath)
	if err != nil {
		t.Fatal(err)
	}
	manager, _, _ := testManager(t, map[string]string{"zerodenet": publicKey})
	host := &connectAcceptanceHost{t: t, subscriptionID: "7"}
	manager.SetHostServices(host)

	installation, err := importFixture(t, manager, packageBytes)
	if err != nil {
		t.Fatalf("import signed Connect package: %v", err)
	}
	if installation.ID != connectPluginID || !installation.Compatibility.Compatible || installation.Enabled {
		t.Fatalf("unexpected imported installation: id=%q compatible=%v enabled=%v", installation.ID, installation.Compatibility.Compatible, installation.Enabled)
	}
	installation, err = manager.Action(context.Background(), installation.ID, "enable", "admin", installation.Generation, false, "")
	if err != nil {
		t.Fatalf("enable Connect: %v", err)
	}
	process := manager.processes[installation.ID]
	if process == nil || process.client.Exited() {
		t.Fatal("Connect server runtime is not running after enable")
	}
	config, err := manager.Config(installation.ID)
	if err != nil {
		t.Fatalf("read initial Connect configuration revision: %v", err)
	}
	adminSession, err := manager.CreateSession(connectPluginID, "client-communication", "admin", 1, true, true)
	if err != nil {
		t.Fatalf("open host-owned configuration page: %v", err)
	}
	saved, err := manager.SaveSessionConfig(context.Background(), adminSession.Token, 1, true, "admin", config.Revision, []byte(`{"enabled":true,"provider_id":"https://panel.example","display_name":"Example"}`))
	if err != nil {
		t.Fatalf("apply Connect configuration: %v", err)
	}
	reloaded, err := manager.Config(installation.ID)
	if err != nil {
		t.Fatalf("reload saved Connect configuration: %v", err)
	}
	if !reloaded.Configured || reloaded.Revision != saved.Revision || !bytes.Contains(reloaded.Config, []byte(`"enabled":true`)) || !bytes.Contains(reloaded.Config, []byte(`"provider_id":"https://panel.example"`)) {
		t.Fatalf("configuration page save did not persist: saved=%#v reloaded=%s", saved, reloaded.Config)
	}

	assertConnectPages(t, manager)
	client, _ := discoverConnectClient(t, manager, connectProviderOrigin)
	passwordCall := client.seal(t, "authorization.password", protocolv1.Authorization{Kind: "password", Credential: "correct horse"}, map[string]any{
		"account": "user@example.com", "device_name": "Installed host test",
	})
	passwordRaw, password := client.exchange(t, manager, passwordCall)
	if password.Status != "ok" {
		t.Fatalf("password authorization failed: %#v", password)
	}
	var credentials struct {
		Access  string `json:"access_credential"`
		Renewal string `json:"renewal_credential"`
	}
	if json.Unmarshal(password.Body, &credentials) != nil || credentials.Access == "" || credentials.Renewal == "" {
		t.Fatalf("missing authorization credentials: %s", password.Body)
	}
	replayedRaw, _ := client.exchange(t, manager, passwordCall)
	if !bytes.Equal(passwordRaw, replayedRaw) || host.accountCalls != 1 {
		t.Fatal("installed runtime did not provide byte-identical mutation replay protection")
	}

	access := protocolv1.Authorization{Kind: "access", Credential: credentials.Access}
	assertConnectOKContains(t, client, manager, "subscriptions.list", access, map[string]any{}, `"subscription_id":"7"`)
	assertConnectOKContains(t, client, manager, "subscriptions.get-content", access, map[string]any{"subscription_id": "7", "known_revision": nil}, `"content":"version: 1\nproxies: []\n"`)
	assertConnectOKContains(t, client, manager, "messages.list", access, map[string]any{"cursor": nil, "limit": 20}, `"message_id":"9"`)
	assertConnectOKContains(t, client, manager, "messages.get", access, map[string]any{"message_id": "9"}, `"body":"Hello"`)
	assertConnectOKContains(t, client, manager, "messages.mark-read", access, map[string]any{"message_id": "9"}, `"read_at":4`)

	renewal := protocolv1.Authorization{Kind: "renewal", Credential: credentials.Renewal}
	_, renewed := client.exchange(t, manager, client.seal(t, "authorization.renew", renewal, map[string]any{}))
	if renewed.Status != "ok" || !bytes.Contains(renewed.Body, []byte(`"access_credential"`)) {
		t.Fatalf("renewal failed: %#v", renewed)
	}

	accountSession, err := manager.CreateSession(connectPluginID, "authorized-devices", "account", 42, false, false)
	if err != nil {
		t.Fatalf("open account contribution: %v", err)
	}
	devices, err := manager.SessionPageAction(context.Background(), accountSession.Token, 42, false, "devices.list", json.RawMessage(`{}`))
	if err != nil || !bytes.Contains(devices, []byte(`"device_id":"device-1"`)) {
		t.Fatalf("account page device action failed: %s %v", devices, err)
	}

	current, err := manager.load(connectPluginID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Action(context.Background(), connectPluginID, "disable", "admin", current.Generation, false, ""); err != nil {
		t.Fatalf("disable Connect: %v", err)
	}
	if !process.client.Exited() {
		t.Fatal("Connect process survived host disable")
	}
	if _, err := manager.HandlePublicRoute(context.Background(), "GET", connectCapabilities, "", nil); !errors.Is(err, ErrRouteNotFound) {
		t.Fatalf("disabled Connect route remained reachable: %v", err)
	}
}

func TestConnectInstalledHostServer(t *testing.T) {
	packagePath := requiredConnectAcceptanceEnv(t, "CONNECT_ZBOARD_PACKAGE")
	publicKey := requiredConnectAcceptanceEnv(t, "CONNECT_PUBLISHER_PUBLIC_KEY")
	readyPath := requiredConnectAcceptanceEnv(t, "CONNECT_ACCEPTANCE_READY")
	stopPath := requiredConnectAcceptanceEnv(t, "CONNECT_ACCEPTANCE_STOP")
	caPath := requiredConnectAcceptanceEnv(t, "CONNECT_ACCEPTANCE_CA")
	packageBytes, err := os.ReadFile(packagePath)
	if err != nil {
		t.Fatal(err)
	}
	manager, _, _ := testManager(t, map[string]string{"zerodenet": publicKey})
	host := &connectAcceptanceHost{t: t, subscriptionID: "7"}
	manager.SetHostServices(host)
	installation, err := importFixture(t, manager, packageBytes)
	if err != nil {
		t.Fatal(err)
	}
	installation, err = manager.Action(context.Background(), installation.ID, "enable", "admin", installation.Generation, false, "")
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, readErr := io.ReadAll(io.LimitReader(request.Body, MaxPublicRouteBodyBytes+1))
		if readErr != nil {
			http.Error(writer, "invalid body", http.StatusBadRequest)
			return
		}
		response, routeErr := manager.HandlePublicRoute(request.Context(), request.Method, request.URL.Path, request.Header.Get("content-type"), body)
		if routeErr != nil {
			http.Error(writer, "route unavailable", http.StatusNotFound)
			return
		}
		writer.Header().Set("content-type", response.ContentType)
		writer.WriteHeader(response.Status)
		_, _ = writer.Write(response.Body)
	}))
	serverCertificate, caPEM := connectAcceptanceTLSCertificate(t)
	server.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{serverCertificate},
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	if err := os.WriteFile(caPath, caPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := manager.Config(installation.ID)
	if err != nil {
		t.Fatal(err)
	}
	configRaw, _ := json.Marshal(map[string]any{"enabled": true, "provider_id": server.URL, "display_name": "Acceptance ZBoard"})
	if _, err := manager.SaveConfig(context.Background(), installation.ID, "admin", config.Revision, configRaw); err != nil {
		t.Fatal(err)
	}

	client, discovery := discoverConnectClient(t, manager, server.URL)
	seed := client.devicePrivate.Seed()
	passwordCall := client.seal(t, "authorization.password", protocolv1.Authorization{Kind: "password", Credential: "correct horse"}, map[string]any{
		"account": "user@example.com", "device_name": "Cross-host acceptance",
	})
	_, password := client.exchange(t, manager, passwordCall)
	if password.Status != "ok" {
		t.Fatalf("bootstrap authorization failed: %#v", password)
	}
	var credentials struct {
		UserID           string `json:"user_id"`
		DeviceID         string `json:"device_id"`
		Access           string `json:"access_credential"`
		AccessExpiresAt  int64  `json:"access_expires_at"`
		Renewal          string `json:"renewal_credential"`
		RenewalExpiresAt int64  `json:"renewal_expires_at"`
	}
	if err := json.Unmarshal(password.Body, &credentials); err != nil {
		t.Fatal(err)
	}
	source := map[string]any{
		"id": "source-1", "name": "Acceptance ZBoard", "origin": server.URL,
		"network_path": "direct", "device_key_name": "connect-device-source-1",
	}
	pinRaw, _ := json.Marshal(map[string]any{
		"provider_id": server.URL, "identity_key_id": discovery.IdentityKeyID,
		"identity_public_key": discovery.IdentityPublicKey, "identity_fingerprint": discovery.IdentityFingerprint,
	})
	fixture := map[string]any{
		"configuration": map[string]string{"provider_origins": mustConnectAcceptanceJSON(t, []any{server.URL})},
		"state": map[string]string{
			"sources/index":                   mustConnectAcceptanceJSON(t, []any{source}),
			"source/source-1/device/identity": mustConnectAcceptanceJSON(t, map[string]any{"device_id": "device-1", "source_id": "source-1"}),
			"source/source-1/session/metadata": mustConnectAcceptanceJSON(t, map[string]any{
				"user_id": credentials.UserID, "device_id": credentials.DeviceID,
				"access_expires_at": credentials.AccessExpiresAt, "renewal_expires_at": credentials.RenewalExpiresAt,
			}),
			"source/source-1/subscription/binding": mustConnectAcceptanceJSON(t, map[string]any{
				"id": "managed-1", "name": "Acceptance ZBoard / Pro", "remote_subscription_id": "7", "revision": "r1",
			}),
			"source/source-1/messages/summary": mustConnectAcceptanceJSON(t, map[string]any{
				"items": []any{map[string]any{"message_id": "9", "title": "Notice", "published_at": 2, "read_at": nil}},
			}),
		},
		"vault_base64": map[string]string{
			"source/source-1/trust/provider":  base64.StdEncoding.EncodeToString(pinRaw),
			"source/source-1/session/access":  base64.StdEncoding.EncodeToString([]byte(credentials.Access)),
			"source/source-1/session/renewal": base64.StdEncoding.EncodeToString([]byte(credentials.Renewal)),
			"keys/connect-device-source-1":    base64.StdEncoding.EncodeToString(seed),
		},
		"scheduled_action": "lifecycle.scheduled.sync.source-1",
		"expected":         map[string]any{"ok": true, "changed": false, "unread": float64(1)},
	}
	fixtureRaw, _ := json.MarshalIndent(fixture, "", "  ")
	if err := os.WriteFile(readyPath, append(fixtureRaw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Minute)
	for {
		if _, err := os.Stat(stopPath); err == nil {
			return
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("cross-host acceptance client did not finish")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func connectAcceptanceTLSCertificate(t *testing.T) (tls.Certificate, []byte) {
	t.Helper()
	_, caPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Connect acceptance root"},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caPrivate.Public(), caPrivate)
	if err != nil {
		t.Fatal(err)
	}
	caCertificate, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	_, serverPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "Connect acceptance server"},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCertificate, serverPrivate.Public(), caPrivate)
	if err != nil {
		t.Fatal(err)
	}
	serverKeyDER, err := x509.MarshalPKCS8PrivateKey(serverPrivate)
	if err != nil {
		t.Fatal(err)
	}
	serverCertificate, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: serverKeyDER}),
	)
	if err != nil {
		t.Fatal(err)
	}
	return serverCertificate, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
}

func requiredConnectAcceptanceEnv(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Fatalf("%s is required", name)
	}
	return value
}

func mustConnectAcceptanceJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func assertConnectPages(t *testing.T, manager *Manager) {
	t.Helper()
	accountPages, err := manager.Pages("account", 42, false)
	if err != nil || len(accountPages) != 1 || accountPages[0].PluginID != connectPluginID || accountPages[0].Page.ID != "authorized-devices" {
		t.Fatalf("account contribution missing or misplaced: %#v %v", accountPages, err)
	}
	adminPages, err := manager.Pages("admin", 1, true)
	if err != nil || len(adminPages) != 0 {
		t.Fatalf("configuration page leaked into business navigation: %#v %v", adminPages, err)
	}
	adminSession, err := manager.CreateSession(connectPluginID, "client-communication", "admin", 1, true, true)
	if err != nil {
		t.Fatalf("open host-owned configuration page: %v", err)
	}
	if asset, err := manager.Asset(adminSession.Token, "ui/admin/index.html"); err != nil || !bytes.Contains(asset, []byte("客户端通信")) {
		t.Fatalf("admin page asset unavailable: %v", err)
	}
}

func discoverConnectClient(t *testing.T, manager *Manager, expectedOrigin string) (connectAcceptanceClient, connectAcceptanceDiscovery) {
	t.Helper()
	response, err := manager.HandlePublicRoute(context.Background(), "GET", connectCapabilities, "", nil)
	if err != nil || response.Status != 200 || response.ContentType != "application/json" {
		t.Fatalf("Connect capability discovery failed: %#v %v", response, err)
	}
	var discovery connectAcceptanceDiscovery
	if err := json.Unmarshal(response.Body, &discovery); err != nil || discovery.ProviderID != expectedOrigin {
		t.Fatalf("invalid discovery response: %s %v", response.Body, err)
	}
	identityPublic, err := base64.RawURLEncoding.DecodeString(discovery.IdentityPublicKey)
	if err != nil || discovery.ProviderKey.Verify(ed25519.PublicKey(identityPublic), time.Now()) != nil {
		t.Fatalf("provider key statement did not verify: %v", err)
	}
	providerPublic, err := base64.RawURLEncoding.DecodeString(discovery.ProviderKey.HPKEPublicKey)
	if err != nil {
		t.Fatal(err)
	}
	_, devicePrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return connectAcceptanceClient{devicePrivate: devicePrivate, providerKeyID: discovery.ProviderKey.KeyID, providerPublic: providerPublic}, discovery
}

func (client connectAcceptanceClient) seal(t *testing.T, operation string, authorization protocolv1.Authorization, body any) connectAcceptanceSealedCall {
	t.Helper()
	responsePublic, responsePrivate, err := protocolv1.GenerateHPKEKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	bodyRaw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	requestID := make([]byte, 16)
	if _, err := rand.Read(requestID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	message := protocolv1.RequestMessage{
		ProtocolVersion: protocolv1.ProtocolVersion,
		Operation:       operation, RequestID: base64.RawURLEncoding.EncodeToString(requestID),
		IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix(),
		SourceID: "source-1", DeviceID: "device-1",
		ResponsePublicKey: base64.RawURLEncoding.EncodeToString(responsePublic),
		Authorization:     authorization, Body: bodyRaw,
	}
	envelope, err := protocolv1.SealRequestMessage(client.providerPublic, client.providerKeyID, message, client.devicePrivate)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return connectAcceptanceSealedCall{raw: raw, responsePrivate: responsePrivate, operation: operation}
}

func (client connectAcceptanceClient) exchange(t *testing.T, manager *Manager, call connectAcceptanceSealedCall) ([]byte, protocolv1.ResponseMessage) {
	t.Helper()
	response, err := manager.HandlePublicRoute(context.Background(), "POST", connectExchange, "application/json", call.raw)
	if err != nil || response.Status != 200 {
		t.Fatalf("Connect exchange failed: %#v %v", response, err)
	}
	envelope, err := protocolv1.DecodeResponseEnvelope(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	message, err := protocolv1.OpenResponseMessage(call.responsePrivate, client.providerPublic, envelope, time.Now(), call.operation)
	if err != nil {
		t.Fatal(err)
	}
	return append([]byte(nil), response.Body...), message
}

func assertConnectOKContains(t *testing.T, client connectAcceptanceClient, manager *Manager, operation string, authorization protocolv1.Authorization, body any, fragment string) {
	t.Helper()
	_, response := client.exchange(t, manager, client.seal(t, operation, authorization, body))
	if response.Status != "ok" || !bytes.Contains(response.Body, []byte(fragment)) {
		t.Fatalf("%s response = %#v", operation, response)
	}
}
