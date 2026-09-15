package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/zerodenet/connect/internal/devsigning"
)

const domain = "znet-sink.plugin-package.v1\x00"

type manifestIdentity struct {
	SchemaVersion uint32 `json:"schema_version"`
	Host          string `json:"host"`
	PluginID      string `json:"plugin_id"`
	ComponentID   string `json:"component_id"`
	Version       string `json:"version"`
	SourceSHA256  string `json:"source_sha256"`
}

type sourceComponent struct {
	Manifest json.RawMessage `json:"manifest"`
	Source   string          `json:"source"`
}

type payload struct {
	SchemaVersion uint32            `json:"schema_version"`
	Host          string            `json:"host"`
	PluginID      string            `json:"plugin_id"`
	Version       string            `json:"version"`
	Components    []sourceComponent `json:"components"`
}

type envelope struct {
	Format    string `json:"format"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type releaseMetadata struct {
	SchemaVersion uint32 `json:"schema_version"`
	Host          string `json:"host"`
	PluginID      string `json:"plugin_id"`
	Version       string `json:"version"`
	Asset         string `json:"asset"`
	SHA256        string `json:"sha256"`
}

func main() {
	manifestPath := flag.String("manifest", "", "component manifest")
	sourcePath := flag.String("source", "", "JavaScript component source")
	keyPath := flag.String("key", "", "base64 Ed25519 private key")
	output := flag.String("out", "", "new .zspkg output")
	metadataPath := flag.String("metadata", "", "new release metadata output")
	flag.Parse()
	if err := run(*manifestPath, *sourcePath, *keyPath, *output, *metadataPath); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(manifestPath, sourcePath, keyPath, output, metadataPath string) error {
	if manifestPath == "" || sourcePath == "" || keyPath == "" || output == "" || metadataPath == "" || output == metadataPath {
		return errors.New("manifest, source, key, out and metadata are required")
	}
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return err
	}
	sourceBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		return err
	}
	if len(manifestBytes) > 16*1024 || len(sourceBytes) > 256*1024 {
		return errors.New("component input exceeds host limits")
	}
	var identity manifestIdentity
	if err := json.Unmarshal(manifestBytes, &identity); err != nil {
		return err
	}
	digest := sha256.Sum256(sourceBytes)
	if identity.SchemaVersion != 1 || identity.Host != "znet-sink" || identity.PluginID == "" || identity.ComponentID == "" || identity.Version == "" || identity.SourceSHA256 != hex.EncodeToString(digest[:]) {
		return errors.New("invalid ZNet Sink component identity or source digest")
	}
	key, err := devsigning.ReadPrivateKey(keyPath)
	if err != nil {
		return err
	}
	document := payload{
		SchemaVersion: 1,
		Host:          "znet-sink",
		PluginID:      identity.PluginID,
		Version:       identity.Version,
		Components:    []sourceComponent{{Manifest: json.RawMessage(manifestBytes), Source: string(sourceBytes)}},
	}
	payloadBytes, err := json.Marshal(document)
	if err != nil {
		return err
	}
	message := append([]byte(domain), payloadBytes...)
	packageBytes, err := json.Marshal(envelope{
		Format:    "znet-sink.plugin-package.v1",
		Payload:   base64.StdEncoding.EncodeToString(payloadBytes),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, message)),
	})
	if err != nil {
		return err
	}
	if err := writeNew(output, packageBytes, 0o600); err != nil {
		return err
	}
	packageDigest := sha256.Sum256(packageBytes)
	metadataBytes, err := json.MarshalIndent(releaseMetadata{
		SchemaVersion: 1,
		Host:          document.Host,
		PluginID:      document.PluginID,
		Version:       document.Version,
		Asset:         filepath.Base(output),
		SHA256:        hex.EncodeToString(packageDigest[:]),
	}, "", "  ")
	if err != nil {
		return err
	}
	metadataBytes = append(metadataBytes, '\n')
	if err := writeNew(metadataPath, metadataBytes, 0o644); err != nil {
		os.Remove(output)
		return err
	}
	fmt.Printf("publisher public key: %s\n", devsigning.PublicKeyText(key))
	return nil
}

func writeNew(path string, value []byte, mode os.FileMode) error {
	handle, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := handle.Write(value); err != nil {
		handle.Close()
		return err
	}
	return handle.Close()
}
