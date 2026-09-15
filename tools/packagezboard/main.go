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
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/zerodenet/connect/internal/devsigning"
)

type signature struct {
	PublicKey string `json:"public_key"`
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"key_id"`
	Value     string `json:"signature"`
}

func main() {
	source := flag.String("source", "", "package source directory")
	keyPath := flag.String("key", "", "base64 Ed25519 private key")
	keyID := flag.String("key-id", "", "publisher key ID")
	output := flag.String("out", "", "new .zbplugin output")
	flag.Parse()
	if err := run(*source, *keyPath, *keyID, *output); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(source, keyPath, keyID, output string) error {
	if source == "" || keyPath == "" || keyID == "" || output == "" {
		return errors.New("source, key, key-id and out are required")
	}
	key, err := devsigning.ReadPrivateKey(keyPath)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(filepath.Join(source, "manifest.json"))
	if err != nil {
		return err
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return err
	}
	if manifest["schema_version"] != float64(1) || manifest["id"] == "" || manifest["version"] == "" {
		return errors.New("invalid ZBoard manifest identity")
	}
	files := map[string][]byte{}
	digests := map[string]string{}
	err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if relative == "manifest.json" {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || !safePath(relative) || (!strings.HasPrefix(relative, "ui/") && !strings.HasPrefix(relative, "runtimes/")) {
			return fmt.Errorf("unexpected package source: %s", relative)
		}
		value, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[relative] = value
		digest := sha256.Sum256(value)
		digests[relative] = hex.EncodeToString(digest[:])
		return nil
	})
	if err != nil {
		return err
	}
	manifest["files"] = digests
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	files["manifest.json"] = manifestBytes
	publicKey := key.Public().(ed25519.PublicKey)
	signed := signature{
		PublicKey: base64.StdEncoding.EncodeToString(publicKey),
		Algorithm: "ed25519",
		KeyID:     keyID,
		Value:     base64.StdEncoding.EncodeToString(ed25519.Sign(key, manifestBytes)),
	}
	files["signature.json"], err = json.Marshal(signed)
	if err != nil {
		return err
	}

	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.Modified = time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)
		header.SetMode(0o644)
		handle, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		if _, err := handle.Write(files[name]); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return writeNew(output, archive.Bytes(), 0o600)
}

func safePath(value string) bool {
	return value != "" && value != "." && !strings.HasPrefix(value, "/") && !strings.Contains(value, "\\") && !strings.Contains(value, "\x00") && filepath.ToSlash(filepath.Clean(value)) == value && !strings.HasPrefix(value, "../")
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
