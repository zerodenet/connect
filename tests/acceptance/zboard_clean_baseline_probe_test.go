//go:build zboard_connect_clean_baseline_probe

package plugins

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestConnectPackageIsAdmittedByCleanHostCapabilityBoundary(t *testing.T) {
	raw, err := os.ReadFile(os.Getenv("CONNECT_ZBOARD_PACKAGE"))
	if err != nil {
		t.Fatal(err)
	}

	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	for _, file := range reader.File {
		if file.Name != "manifest.json" {
			continue
		}
		entry, openErr := file.Open()
		if openErr != nil {
			t.Fatal(openErr)
		}
		decodeErr := json.NewDecoder(entry).Decode(&manifest)
		entry.Close()
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		break
	}
	if manifest.ID != "org.zerodenet.connect.zboard" {
		t.Fatalf("unexpected package identity %q", manifest.ID)
	}
	for _, capability := range []string{
		"zboard.http.route.v1",
		"zboard.account.assertion.v1",
		"zboard.subscription.projection.v1",
		"zboard.message.projection.v1",
	} {
		found := false
		for _, declared := range manifest.Capabilities {
			found = found || declared == capability
		}
		if !found {
			t.Fatalf("probe package does not declare required capability %q", capability)
		}
	}

	pack, err := ReadPackage(raw, map[string]string{
		"zerodenet": strings.TrimSpace(os.Getenv("CONNECT_PUBLISHER_PUBLIC_KEY")),
	})
	if err != nil {
		t.Fatalf("clean host rejected Connect despite published capabilities: %v", err)
	}
	if pack.Manifest.ID != manifest.ID || pack.Manifest.Version != manifest.Version {
		t.Fatalf("admitted package identity changed: id=%q version=%q", pack.Manifest.ID, pack.Manifest.Version)
	}
	t.Logf("clean host admitted signed package %s at capability boundary", pack.Manifest.ID)
}
