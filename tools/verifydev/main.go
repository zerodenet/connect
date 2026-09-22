package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const sinkDomainApplication = "znet-sink.plugin-package.v1.zip\x00"

type signature struct {
	PublicKey string `json:"public_key"`
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"key_id"`
	Value     string `json:"signature"`
}

type zboardManifest struct {
	ID           string            `json:"id"`
	Version      string            `json:"version"`
	Capabilities []string          `json:"capabilities"`
	Surfaces     []string          `json:"surfaces"`
	Files        map[string]string `json:"files"`
	Components   struct {
		UI     map[string]string `json:"ui"`
		Server *struct {
			Executables map[string]string `json:"executables"`
		} `json:"server"`
	} `json:"components"`
	Contributions struct {
		Pages []struct {
			ID      string `json:"id"`
			Surface string `json:"surface"`
			Purpose string `json:"purpose"`
		} `json:"pages"`
	} `json:"contributions"`
}

type envelope struct {
	Format       string          `json:"format"`
	Registration json.RawMessage `json:"registration"`
	Payload      string          `json:"payload"`
	Signature    string          `json:"signature"`
}

type sinkRegistration struct {
	ProductID string `json:"product_id"`
	ID        string `json:"id"`
	Publisher struct {
		ID        string `json:"id"`
		PublicKey string `json:"public_key"`
	} `json:"publisher"`
	Surfaces     []string `json:"surfaces"`
	Capabilities []string `json:"capabilities"`
}

type sinkPermission struct {
	Capability string `json:"capability"`
}

type sinkApplication struct {
	Host       string `json:"host"`
	PluginID   string `json:"plugin_id"`
	Version    string `json:"version"`
	Components []struct {
		ID       string `json:"id"`
		Manifest string `json:"manifest"`
		Entry    string `json:"entry"`
	} `json:"components"`
	Pages []struct {
		ID      string   `json:"id"`
		Title   string   `json:"title"`
		Kind    string   `json:"kind"`
		Entry   string   `json:"entry"`
		Scripts []string `json:"scripts"`
	} `json:"pages"`
	Files map[string]struct {
		SHA256 string `json:"sha256"`
		Size   int64  `json:"size"`
	} `json:"files"`
}

func main() {
	if len(os.Args) < 5 {
		fatal(errors.New("usage: verifydev PUBLIC_KEY ZNET_SINK_PACKAGE VERSION ZBOARD_PACKAGE..."))
	}
	key, err := readPublicKey(os.Args[1])
	if err != nil {
		fatal(err)
	}
	if err := verifySink(os.Args[2], os.Args[3], key); err != nil {
		fatal(fmt.Errorf("verify ZNet Sink package: %w", err))
	}
	seen := map[string]bool{}
	for _, path := range os.Args[4:] {
		platform, err := verifyZBoard(path, os.Args[3], key)
		if err != nil {
			fatal(fmt.Errorf("verify ZBoard package: %w", err))
		}
		if seen[platform] {
			fatal(fmt.Errorf("duplicate ZBoard platform package: %s", platform))
		}
		seen[platform] = true
	}
	for _, platform := range []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64"} {
		if !seen[platform] {
			fatal(fmt.Errorf("missing ZBoard platform package: %s", platform))
		}
	}
	fmt.Println("verified both package signatures, identities, versions, and payload digests")
}

func readPublicKey(path string) (ed25519.PublicKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(decoded) != ed25519.PublicKeySize {
		return nil, errors.New("invalid Ed25519 public key")
	}
	return ed25519.PublicKey(decoded), nil
}

func verifyZBoard(path, version string, key ed25519.PublicKey) (string, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer archive.Close()
	files := map[string][]byte{}
	for _, file := range archive.File {
		handle, err := file.Open()
		if err != nil {
			return "", err
		}
		value, err := io.ReadAll(handle)
		handle.Close()
		if err != nil {
			return "", err
		}
		files[file.Name] = value
	}
	var manifest zboardManifest
	if err := json.Unmarshal(files["manifest.json"], &manifest); err != nil {
		return "", err
	}
	var signed signature
	if err := json.Unmarshal(files["signature.json"], &signed); err != nil {
		return "", err
	}
	signatureBytes, err := base64.StdEncoding.DecodeString(signed.Value)
	if err != nil || signed.Algorithm != "ed25519" || signed.KeyID != "zerodenet" || !ed25519.Verify(key, files["manifest.json"], signatureBytes) {
		return "", errors.New("invalid manifest signature")
	}
	if signed.PublicKey != "" && signed.PublicKey != base64.StdEncoding.EncodeToString(key) {
		return "", errors.New("embedded public key differs")
	}
	if manifest.ID != "org.zerodenet.connect.zboard" || manifest.Version != version {
		return "", errors.New("package identity or version differs")
	}
	if strings.Join(manifest.Capabilities, ",") != "zboard.ui.page.v1,zboard.config.v1,zboard.storage.v1,zboard.http.route.v1,zboard.account.assertion.v1,zboard.subscription.projection.v1,zboard.message.projection.v1" {
		return "", errors.New("ZBoard package does not declare the complete Connect host capability set")
	}
	if len(manifest.Surfaces) != 2 || manifest.Surfaces[0] != "account" || manifest.Surfaces[1] != "admin" {
		return "", errors.New("ZBoard package does not expose the complete account and admin surfaces")
	}
	expectedExecutables := map[string]string{
		"linux-amd64":   "runtimes/linux-amd64/connect",
		"linux-arm64":   "runtimes/linux-arm64/connect",
		"darwin-amd64":  "runtimes/darwin-amd64/connect",
		"darwin-arm64":  "runtimes/darwin-arm64/connect",
		"windows-amd64": "runtimes/windows-amd64/connect.exe",
	}
	if len(manifest.Components.UI) != 2 || manifest.Components.UI["account"] != "ui/account/index.html" || manifest.Components.UI["admin"] != "ui/admin/index.html" || manifest.Components.Server == nil || len(manifest.Components.Server.Executables) != 1 {
		return "", errors.New("ZBoard package is missing a UI or single-platform server runtime component")
	}
	platform := ""
	for candidate, path := range manifest.Components.Server.Executables {
		if expectedExecutables[candidate] != path {
			return "", errors.New("ZBoard package declares an unexpected server runtime")
		}
		platform = candidate
	}
	if len(manifest.Contributions.Pages) != 2 {
		return "", errors.New("ZBoard package does not declare both Connect pages")
	}
	pages := map[string]string{}
	for _, page := range manifest.Contributions.Pages {
		pages[page.Surface+":"+page.ID] = page.Purpose
	}
	if pages["account:authorized-devices"] != "business" || pages["admin:client-communication"] != "configuration" {
		return "", errors.New("ZBoard Connect page contributions differ")
	}
	for _, path := range manifest.Components.UI {
		if len(files[path]) == 0 {
			return "", fmt.Errorf("missing ZBoard UI entrypoint: %s", path)
		}
	}
	if len(files) != len(manifest.Files)+2 {
		return "", errors.New("undeclared package file")
	}
	for name, expected := range manifest.Files {
		value, ok := files[name]
		if !ok || hex.EncodeToString(hash(value)) != expected {
			return "", fmt.Errorf("invalid file digest: %s", name)
		}
	}
	return platform, nil
}

func verifySink(path, version string, key ed25519.PublicKey) error {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer archive.Close()
	files := map[string][]byte{}
	for _, file := range archive.File {
		if _, exists := files[file.Name]; exists || file.FileInfo().IsDir() {
			return errors.New("duplicate or directory package entry")
		}
		handle, err := file.Open()
		if err != nil {
			return err
		}
		value, err := io.ReadAll(io.LimitReader(handle, 4*1024*1024+1))
		handle.Close()
		if err != nil || len(value) > 4*1024*1024 {
			return errors.New("invalid package entry")
		}
		files[file.Name] = value
	}
	var signed envelope
	if err := json.Unmarshal(files["META-INF/signature.json"], &signed); err != nil {
		return err
	}
	if signed.Format != "znet-sink.plugin-package.v1" || len(signed.Registration) == 0 || len(signed.Payload) != 0 {
		return errors.New("invalid application signature envelope")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, signed.Registration); err != nil {
		return err
	}
	signatureBytes, err := base64.StdEncoding.DecodeString(signed.Signature)
	message := append([]byte(sinkDomainApplication), compact.Bytes()...)
	message = append(message, 0)
	message = append(message, files["plugin.json"]...)
	if err != nil || !ed25519.Verify(key, message, signatureBytes) {
		return errors.New("invalid application package signature")
	}
	var registration sinkRegistration
	if err := json.Unmarshal(signed.Registration, &registration); err != nil {
		return err
	}
	if registration.ProductID != "org.zerodenet.connect" || registration.ID != "org.zerodenet.connect.znet-sink" ||
		registration.Publisher.ID != "zerodenet" || registration.Publisher.PublicKey != base64.StdEncoding.EncodeToString(key) ||
		strings.Join(registration.Surfaces, ",") != "znet-sink.ui.management.v1" {
		return errors.New("embedded local-install registration differs")
	}
	var document sinkApplication
	if err := json.Unmarshal(files["plugin.json"], &document); err != nil {
		return err
	}
	if document.Host != "znet-sink" || document.PluginID != "org.zerodenet.connect.znet-sink" || document.Version != version || len(document.Components) != 1 {
		return errors.New("package identity, version, or components differ")
	}
	if len(files) != len(document.Files)+2 {
		return errors.New("application package has undeclared files")
	}
	for name, digest := range document.Files {
		value, exists := files[name]
		if !exists || int64(len(value)) != digest.Size || hex.EncodeToString(hash(value)) != digest.SHA256 {
			return fmt.Errorf("application file digest differs: %s", name)
		}
	}
	capabilities := map[string]bool{}
	for _, component := range document.Components {
		var manifest struct {
			PluginID     string           `json:"plugin_id"`
			ComponentID  string           `json:"component_id"`
			Version      string           `json:"version"`
			Runtime      string           `json:"runtime"`
			SourceSHA256 string           `json:"source_sha256"`
			Required     []sinkPermission `json:"required"`
			Optional     []sinkPermission `json:"optional"`
		}
		if err := json.Unmarshal(files[component.Manifest], &manifest); err != nil {
			return err
		}
		if component.ID != "provider-source" || component.Entry != "components/provider-source/index.mjs" ||
			manifest.PluginID != document.PluginID || manifest.ComponentID != component.ID || manifest.Version != version ||
			manifest.Runtime != "javascript-module-v1" || !bytes.Equal(hash(files[component.Entry]), decodeHex(manifest.SourceSHA256)) {
			return errors.New("component identity or source digest differs")
		}
		if len(files["components/provider-source/background.mjs"]) == 0 ||
			!bytes.Contains(files[component.Entry], []byte("from './background.mjs'")) {
			return errors.New("scheduled synchronization module is missing")
		}
		for _, permission := range append(manifest.Required, manifest.Optional...) {
			capabilities[permission.Capability] = true
		}
	}
	if len(capabilities) != len(registration.Capabilities) {
		return errors.New("embedded capability registration differs")
	}
	for _, capability := range registration.Capabilities {
		if !capabilities[capability] {
			return errors.New("embedded capability registration differs")
		}
	}
	if len(document.Pages) != 1 || document.Pages[0].ID != "manage" || document.Pages[0].Kind != "management" || document.Pages[0].Title == "" ||
		document.Pages[0].Entry != "ui/manage/index.html" || len(document.Pages[0].Scripts) != 1 || document.Pages[0].Scripts[0] != "ui/manage/page.js" ||
		!strings.Contains(string(files[document.Pages[0].Entry]), "data-znet-layout=\"settings\"") ||
		!strings.Contains(string(files[document.Pages[0].Scripts[0]]), "znetPlugin.capabilities.call") ||
		!strings.Contains(string(files[document.Pages[0].Scripts[0]]), "znetPlugin.configuration.save") {
		return errors.New("ZNet Sink management page differs")
	}
	return nil
}

func hash(value []byte) []byte {
	digest := sha256.Sum256(value)
	return digest[:]
}

func decodeHex(value string) []byte {
	decoded, _ := hex.DecodeString(value)
	return decoded
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
