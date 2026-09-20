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

const domain = "znet-sink.plugin-package.v2\x00"

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

type sourcePage struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Kind  string `json:"kind"`
	HTML  string `json:"html"`
}

type payload struct {
	SchemaVersion uint32            `json:"schema_version"`
	Host          string            `json:"host"`
	PluginID      string            `json:"plugin_id"`
	Version       string            `json:"version"`
	Components    []sourceComponent `json:"components"`
	Pages         []sourcePage      `json:"pages,omitempty"`
}

type envelope struct {
	Format       string        `json:"format"`
	Registration *registration `json:"registration"`
	Payload      string        `json:"payload"`
	Signature    string        `json:"signature"`
}

// Field order intentionally matches the ZNet Sink Registration structure.
// The host re-serializes this signed object before verification.
type registration struct {
	ProductID     *string       `json:"product_id,omitempty"`
	ID            string        `json:"id"`
	Repository    string        `json:"repository"`
	Publisher     publisher     `json:"publisher"`
	Name          string        `json:"name"`
	Description   string        `json:"description"`
	License       string        `json:"license"`
	Maintainers   []string      `json:"maintainers"`
	Homepage      *string       `json:"homepage"`
	Documentation *string       `json:"documentation"`
	Security      *string       `json:"security"`
	ReleaseSource releaseSource `json:"release_source"`
	Surfaces      []string      `json:"surfaces"`
	Capabilities  []string      `json:"capabilities"`
	Releases      []any         `json:"releases,omitempty"`
}

type publisher struct {
	ID        string `json:"id"`
	PublicKey string `json:"public_key"`
}

type releaseSource struct {
	Type          string `json:"type"`
	MetadataAsset string `json:"metadata_asset"`
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
	registrationPath := flag.String("registration", "", "embedded local-install publisher registration")
	pagePath := flag.String("management-page", "", "optional signed management page HTML")
	pageID := flag.String("management-page-id", "manage", "management page ID")
	pageTitle := flag.String("management-page-title", "管理", "management page title")
	flag.Parse()
	if err := run(*manifestPath, *sourcePath, *keyPath, *registrationPath, *output, *metadataPath, *pagePath, *pageID, *pageTitle); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(manifestPath, sourcePath, keyPath, registrationPath, output, metadataPath, pagePath, pageID, pageTitle string) error {
	if manifestPath == "" || sourcePath == "" || keyPath == "" || registrationPath == "" || output == "" || metadataPath == "" || output == metadataPath {
		return errors.New("manifest, source, key, registration, out and metadata are required")
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
	registrationBytes, err := os.ReadFile(registrationPath)
	if err != nil {
		return err
	}
	var localRegistration registration
	if err := json.Unmarshal(registrationBytes, &localRegistration); err != nil {
		return err
	}
	localRegistration.Publisher.PublicKey = base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
	if err := validateRegistration(localRegistration, identity.PluginID); err != nil {
		return err
	}
	document := payload{
		SchemaVersion: 1,
		Host:          "znet-sink",
		PluginID:      identity.PluginID,
		Version:       identity.Version,
		Components:    []sourceComponent{{Manifest: json.RawMessage(manifestBytes), Source: string(sourceBytes)}},
	}
	if pagePath != "" {
		pageBytes, err := os.ReadFile(pagePath)
		if err != nil {
			return err
		}
		if len(pageBytes) == 0 || len(pageBytes) > 512*1024 || !safeIdentifier(pageID) || pageTitle == "" || len(pageTitle) > 80 {
			return errors.New("invalid management page")
		}
		document.Pages = []sourcePage{{ID: pageID, Title: pageTitle, Kind: "management", HTML: string(pageBytes)}}
	}
	payloadBytes, err := json.Marshal(document)
	if err != nil {
		return err
	}
	registrationBytes, err = json.Marshal(localRegistration)
	if err != nil {
		return err
	}
	message := append([]byte(domain), registrationBytes...)
	message = append(message, 0)
	message = append(message, payloadBytes...)
	packageBytes, err := json.Marshal(envelope{
		Format:       "znet-sink.plugin-package.v2",
		Registration: &localRegistration,
		Payload:      base64.StdEncoding.EncodeToString(payloadBytes),
		Signature:    base64.StdEncoding.EncodeToString(ed25519.Sign(key, message)),
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

func validateRegistration(value registration, pluginID string) error {
	if value.ID != pluginID || value.Publisher.ID == "" || value.Name == "" || value.Description == "" ||
		value.Repository == "" || value.License == "" || len(value.Maintainers) == 0 ||
		value.ReleaseSource.Type != "github-releases" || value.ReleaseSource.MetadataAsset == "" ||
		len(value.Surfaces) == 0 || len(value.Capabilities) == 0 {
		return errors.New("invalid embedded local-install registration")
	}
	return nil
}

func safeIdentifier(value string) bool {
	if value == "" || len(value) > 80 {
		return false
	}
	for _, value := range []byte(value) {
		if !((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9') || value == '.' || value == '_' || value == '-') {
			return false
		}
	}
	return true
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
