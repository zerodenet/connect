package protocolv1

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestRequestMessageProofAndWindow(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	_, devicePrivate, err := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{0x51}, ed25519.SeedSize)))
	if err != nil {
		t.Fatal(err)
	}
	message := validRequestMessage(now)
	if err := message.Sign(devicePrivate); err != nil {
		t.Fatal(err)
	}
	if err := message.Verify(now); err != nil {
		t.Fatal(err)
	}

	tampered := message
	tampered.Body = json.RawMessage(`{"subscription_id":"other"}`)
	if err := tampered.Verify(now); !errors.Is(err, ErrInvalidProof) {
		t.Fatalf("body tampering error = %v", err)
	}

	expired := message
	if err := expired.Verify(now.Add(MaxRequestLifetime + ClockSkew + time.Second)); !errors.Is(err, ErrExpiredMessage) {
		t.Fatalf("expired request error = %v", err)
	}
}

func TestRequestMessageRejectsWrongAuthorizationAndUnknownFields(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	_, devicePrivate, err := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{0x52}, ed25519.SeedSize)))
	if err != nil {
		t.Fatal(err)
	}
	message := validRequestMessage(now)
	message.Authorization.Kind = "renewal"
	if err := message.Sign(devicePrivate); err != nil {
		t.Fatal(err)
	}
	if err := message.Verify(now); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("wrong authorization error = %v", err)
	}

	message = validRequestMessage(now)
	if err := message.Sign(devicePrivate); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw[:len(raw)-1], []byte(`,"unexpected":true}`)...)
	if _, err := DecodeRequestMessage(raw, now); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("unknown field error = %v", err)
	}
}

func validRequestMessage(now time.Time) RequestMessage {
	return RequestMessage{
		ProtocolVersion:   ProtocolVersion,
		Operation:         "subscriptions.get-content",
		RequestID:         encodeBinary([]byte("0123456789abcdef")),
		IssuedAt:          now.Unix(),
		ExpiresAt:         now.Add(90 * time.Second).Unix(),
		SourceID:          "source-local-1",
		DeviceID:          "device-local-1",
		ResponsePublicKey: encodeBinary(bytes.Repeat([]byte{0x53}, 32)),
		Authorization: Authorization{
			Kind:       "access",
			Credential: "access-secret",
		},
		Body: json.RawMessage(`{"subscription_id":"primary"}`),
	}
}
