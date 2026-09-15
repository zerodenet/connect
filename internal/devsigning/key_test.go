package devsigning

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestReadPrivateKey(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "publisher.key")
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(privateKey)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := ReadPrivateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if PublicKeyText(loaded) != base64.StdEncoding.EncodeToString(publicKey) {
		t.Fatal("derived public key differs")
	}
}
