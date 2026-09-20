package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRunIncludesSignedManagementPage(t *testing.T) {
	root := t.TempDir()
	source := "({ok:true})"
	manifest := `{"schema_version":1,"host":"znet-sink","plugin_id":"org.example.connect","component_id":"source","version":"1.0.0","source_sha256":"` + sha256Text([]byte(source)) + `"}`
	manifestPath := writeTestFile(t, root, "manifest.json", []byte(manifest))
	sourcePath := writeTestFile(t, root, "source.mjs", []byte(source))
	pagePath := writeTestFile(t, root, "manage.html", []byte("<!doctype html><title>Manage</title>"))
	_, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := writeTestFile(t, root, "publisher.key", []byte(base64.StdEncoding.EncodeToString(privateKey)))
	registrationPath := writeRegistration(t, root, "org.example.connect")
	packagePath := filepath.Join(root, "plugin.zspkg")
	metadataPath := filepath.Join(root, "release.json")
	if err := run(manifestPath, sourcePath, keyPath, registrationPath, packagePath, metadataPath, pagePath, "manage", "Connect 管理"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(packagePath)
	if err != nil {
		t.Fatal(err)
	}
	var wrapped envelope
	if err := json.Unmarshal(raw, &wrapped); err != nil {
		t.Fatal(err)
	}
	if wrapped.Format != "znet-sink.plugin-package.v2" || wrapped.Registration == nil || wrapped.Registration.ID != "org.example.connect" {
		t.Fatalf("package is not self-contained for local installation: %#v", wrapped)
	}
	publicKey, err := base64.StdEncoding.DecodeString(wrapped.Registration.Publisher.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(wrapped.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var document payload
	if err := json.Unmarshal(payloadBytes, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Pages) != 1 || document.Pages[0].ID != "manage" || document.Pages[0].Kind != "management" || document.Pages[0].HTML != "<!doctype html><title>Manage</title>" {
		t.Fatalf("unexpected pages: %#v", document.Pages)
	}
	registrationBytes, err := json.Marshal(wrapped.Registration)
	if err != nil {
		t.Fatal(err)
	}
	message := append([]byte(domain), registrationBytes...)
	message = append(message, 0)
	message = append(message, payloadBytes...)
	signature, err := base64.StdEncoding.DecodeString(wrapped.Signature)
	if err != nil || !ed25519.Verify(publicKey, message, signature) {
		t.Fatal("self-contained package signature did not verify")
	}
}

func TestRunRejectsInvalidManagementPageIdentity(t *testing.T) {
	root := t.TempDir()
	source := "({ok:true})"
	manifest := `{"schema_version":1,"host":"znet-sink","plugin_id":"org.example.connect","component_id":"source","version":"1.0.0","source_sha256":"` + sha256Text([]byte(source)) + `"}`
	_, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	err = run(
		writeTestFile(t, root, "manifest.json", []byte(manifest)),
		writeTestFile(t, root, "source.mjs", []byte(source)),
		writeTestFile(t, root, "publisher.key", []byte(base64.StdEncoding.EncodeToString(privateKey))),
		writeRegistration(t, root, "org.example.connect"),
		filepath.Join(root, "plugin.zspkg"), filepath.Join(root, "release.json"),
		writeTestFile(t, root, "manage.html", []byte("<p>x</p>")), "../manage", "Manage",
	)
	if err == nil {
		t.Fatal("expected invalid page identity")
	}
}

func writeRegistration(t *testing.T, root, pluginID string) string {
	t.Helper()
	value := `{"product_id":"org.example","id":"` + pluginID + `","repository":"https://github.com/example/connect","publisher":{"id":"example","public_key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"name":"Connect","description":"Test Connect package","license":"MPL-2.0","maintainers":["example"],"homepage":null,"documentation":null,"security":null,"release_source":{"type":"github-releases","metadata_asset":"marketplace-entry.json"},"surfaces":["znet-sink.ui.management.v1"],"capabilities":["plugin.self.read"]}`
	return writeTestFile(t, root, "registration.json", []byte(value))
}

func writeTestFile(t *testing.T, root, name string, value []byte) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, value, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func sha256Text(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
