package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestDeriveSeedFromExistingPublisherIdentity(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	keyPath := filepath.Join(root, "publisher.key")
	pubPath := keyPath + ".pub"
	seedPath := filepath.Join(root, "publisher.seed")
	if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(private)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pubPath, []byte(base64.StdEncoding.EncodeToString(public)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{keyPath, pubPath, seedPath}
	for range 2 {
		if err := derive(args); err != nil {
			t.Fatal(err)
		}
	}
	seed, err := os.ReadFile(seedPath)
	if err != nil || !bytes.Equal(seed, private.Seed()) {
		t.Fatal("seed must match the existing publisher key")
	}
	info, err := os.Stat(seedPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("seed must be private")
	}
	otherSeed := bytes.Repeat([]byte{1}, ed25519.SeedSize)
	if err := os.WriteFile(seedPath, otherSeed, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := derive(args); err == nil {
		t.Fatal("must reject an existing seed from a different identity")
	}
	unchanged, _ := os.ReadFile(seedPath)
	if !bytes.Equal(unchanged, otherSeed) {
		t.Fatal("must not overwrite a conflicting identity")
	}
}
