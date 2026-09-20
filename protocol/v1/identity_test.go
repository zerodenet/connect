package protocolv1

import (
	"bytes"
	"crypto/ed25519"
	"testing"
	"time"
)

func TestProviderKeyAndIdentityRotation(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	oldPublic, oldPrivate, err := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{0x61}, ed25519.SeedSize)))
	if err != nil {
		t.Fatal(err)
	}
	newPublic, newPrivate, err := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{0x62}, ed25519.SeedSize)))
	if err != nil {
		t.Fatal(err)
	}
	providerPublic, _ := derivedHPKEKeyPair(t, bytes.Repeat([]byte{0x63}, 32))

	statement := ProviderKeyStatement{
		ProtocolVersion: ProtocolVersion,
		ProviderID:      "https://provider.example",
		IdentityKeyID:   "identity-1",
		KeyID:           "hpke-1",
		HPKEPublicKey:   encodeBinary(providerPublic),
		NotBefore:       now.Add(-time.Minute).Unix(),
		NotAfter:        now.Add(24 * time.Hour).Unix(),
	}
	if err := statement.Sign(oldPrivate); err != nil {
		t.Fatal(err)
	}
	if err := statement.Verify(oldPublic, now); err != nil {
		t.Fatal(err)
	}
	tampered := statement
	tampered.KeyID = "hpke-2"
	if err := tampered.Verify(oldPublic, now); err == nil {
		t.Fatal("tampered provider key statement was accepted")
	}

	rotation := IdentityRotationStatement{
		ProtocolVersion:  ProtocolVersion,
		ProviderID:       "https://provider.example",
		OldIdentityKeyID: "identity-1",
		NewIdentityKeyID: "identity-2",
		NotBefore:        now.Add(-time.Minute).Unix(),
	}
	if err := rotation.Sign(oldPrivate, newPrivate); err != nil {
		t.Fatal(err)
	}
	verifiedNew, err := rotation.Verify(oldPublic, now)
	if err != nil || !bytes.Equal(verifiedNew, newPublic) {
		t.Fatalf("rotation verification: public=%x err=%v", verifiedNew, err)
	}
}
