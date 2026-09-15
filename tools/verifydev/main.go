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

const domain = "znet-sink.plugin-package.v1\x00"

type signature struct {
	PublicKey string `json:"public_key"`
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"key_id"`
	Value     string `json:"signature"`
}

type zboardManifest struct {
	ID      string            `json:"id"`
	Version string            `json:"version"`
	Files   map[string]string `json:"files"`
}

type envelope struct {
	Format    string `json:"format"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type sinkPayload struct {
	Host       string `json:"host"`
	PluginID   string `json:"plugin_id"`
	Version    string `json:"version"`
	Components []struct {
		Manifest struct {
			PluginID     string `json:"plugin_id"`
			Version      string `json:"version"`
			SourceSHA256 string `json:"source_sha256"`
		} `json:"manifest"`
		Source string `json:"source"`
	} `json:"components"`
}

func main() {
	if len(os.Args) != 5 {
		fatal(errors.New("usage: verifydev PUBLIC_KEY ZBOARD_PACKAGE ZNET_SINK_PACKAGE VERSION"))
	}
	key, err := readPublicKey(os.Args[1])
	if err != nil {
		fatal(err)
	}
	if err := verifyZBoard(os.Args[2], os.Args[4], key); err != nil {
		fatal(fmt.Errorf("verify ZBoard package: %w", err))
	}
	if err := verifySink(os.Args[3], os.Args[4], key); err != nil {
		fatal(fmt.Errorf("verify ZNet Sink package: %w", err))
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

func verifyZBoard(path, version string, key ed25519.PublicKey) error {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer archive.Close()
	files := map[string][]byte{}
	for _, file := range archive.File {
		handle, err := file.Open()
		if err != nil {
			return err
		}
		value, err := io.ReadAll(handle)
		handle.Close()
		if err != nil {
			return err
		}
		files[file.Name] = value
	}
	var manifest zboardManifest
	if err := json.Unmarshal(files["manifest.json"], &manifest); err != nil {
		return err
	}
	var signed signature
	if err := json.Unmarshal(files["signature.json"], &signed); err != nil {
		return err
	}
	signatureBytes, err := base64.StdEncoding.DecodeString(signed.Value)
	if err != nil || signed.Algorithm != "ed25519" || signed.KeyID != "zerodenet" || !ed25519.Verify(key, files["manifest.json"], signatureBytes) {
		return errors.New("invalid manifest signature")
	}
	if signed.PublicKey != "" && signed.PublicKey != base64.StdEncoding.EncodeToString(key) {
		return errors.New("embedded public key differs")
	}
	if manifest.ID != "org.zerodenet.connect.zboard" || manifest.Version != version {
		return errors.New("package identity or version differs")
	}
	if len(files) != len(manifest.Files)+2 {
		return errors.New("undeclared package file")
	}
	for name, expected := range manifest.Files {
		value, ok := files[name]
		if !ok || hex.EncodeToString(hash(value)) != expected {
			return fmt.Errorf("invalid file digest: %s", name)
		}
	}
	return nil
}

func verifySink(path, version string, key ed25519.PublicKey) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var signed envelope
	if err := json.Unmarshal(raw, &signed); err != nil {
		return err
	}
	payload, err := base64.StdEncoding.DecodeString(signed.Payload)
	if err != nil || signed.Format != "znet-sink.plugin-package.v1" {
		return errors.New("invalid package envelope")
	}
	signatureBytes, err := base64.StdEncoding.DecodeString(signed.Signature)
	message := append([]byte(domain), payload...)
	if err != nil || !ed25519.Verify(key, message, signatureBytes) {
		return errors.New("invalid package signature")
	}
	var document sinkPayload
	if err := json.Unmarshal(payload, &document); err != nil {
		return err
	}
	if document.Host != "znet-sink" || document.PluginID != "org.zerodenet.connect.znet-sink" || document.Version != version || len(document.Components) == 0 {
		return errors.New("package identity, version, or components differ")
	}
	for _, component := range document.Components {
		if component.Manifest.PluginID != document.PluginID || component.Manifest.Version != version || !bytes.Equal(hash([]byte(component.Source)), decodeHex(component.Manifest.SourceSHA256)) {
			return errors.New("component identity or source digest differs")
		}
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
