package main

import (
	"crypto/ed25519"
	"testing"
	"time"

	protocolv1 "github.com/zerodenet/connect/protocol/v1"
)

func TestProviderKeyRotationRetainsOldDecryptKeyThroughStatementLifetime(t *testing.T) {
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	state, err := newProviderState("https://panel.example", now)
	if err != nil {
		t.Fatal(err)
	}
	oldID := state.HPKEKeyID
	oldNotAfter := now.Add(providerKeyRotationLead - time.Minute).Unix()
	state.ProviderKeyStatement.NotAfter = oldNotAfter
	identityPrivate, _ := decodeBytes(state.IdentityPrivateKey, ed25519.PrivateKeySize)
	if err := state.ProviderKeyStatement.Sign(ed25519.PrivateKey(identityPrivate)); err != nil {
		t.Fatal(err)
	}
	rotated, err := state.rotateProviderKey(now)
	if err != nil || !rotated {
		t.Fatalf("rotation: %v %v", rotated, err)
	}
	if state.HPKEKeyID == oldID || len(state.PreviousHPKEKeys) != 1 {
		t.Fatal("old provider key was not retained")
	}
	if _, ok := state.responseKey(oldID, time.Unix(oldNotAfter, 0)); !ok {
		t.Fatal("old key was unavailable before its statement expired")
	}
	if _, ok := state.responseKey(oldID, time.Unix(oldNotAfter, 0).Add(protocolv1.ClockSkew+time.Second)); ok {
		t.Fatal("old key survived past its allowed skew")
	}
	if err := state.validate(now); err != nil {
		t.Fatal(err)
	}
}
