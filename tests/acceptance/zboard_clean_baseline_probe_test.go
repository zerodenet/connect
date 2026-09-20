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

func TestConnectPackageIsRejectedByCleanHostCapabilityBoundary(t *testing.T) {
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

	_, err = ReadPackage(raw, map[string]string{
		"zerodenet": strings.TrimSpace(os.Getenv("CONNECT_PUBLISHER_PUBLIC_KEY")),
	})
	if err == nil {
		t.Fatal("clean host admitted Connect despite absent public capabilities")
	}
	if !strings.Contains(err.Error(), "declare supported capabilities") &&
		!strings.Contains(err.Error(), "unsupported or duplicate capability") &&
		!strings.Contains(err.Error(), "invalid JSON or unsupported fields") {
		t.Fatalf("package failed for an unrelated reason: %v", err)
	}
	t.Logf("clean host correctly rejected the package at capability admission: %v", err)
}
