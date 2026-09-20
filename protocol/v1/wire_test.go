package protocolv1

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/cloudflare/circl/hpke"
)

func TestRequestAndAuthenticatedResponseRoundTrip(t *testing.T) {
	providerPublic, providerPrivate := derivedHPKEKeyPair(t, bytes.Repeat([]byte{0x11}, 32))
	clientPublic, clientPrivate := derivedHPKEKeyPair(t, bytes.Repeat([]byte{0x22}, 32))
	requestID := encodeBinary([]byte("0123456789abcdef"))

	request, err := SealRequest(providerPublic, "provider-2026-09", requestID, []byte("request plaintext"))
	if err != nil {
		t.Fatal(err)
	}
	openedRequest, err := OpenRequest(providerPrivate, request)
	if err != nil || string(openedRequest) != "request plaintext" {
		t.Fatalf("request round trip: plaintext=%q err=%v", openedRequest, err)
	}

	response, err := SealResponse(providerPrivate, clientPublic, "provider-2026-09", requestID, []byte("response plaintext"))
	if err != nil {
		t.Fatal(err)
	}
	openedResponse, err := OpenResponse(clientPrivate, providerPublic, response)
	if err != nil || string(openedResponse) != "response plaintext" {
		t.Fatalf("response round trip: plaintext=%q err=%v", openedResponse, err)
	}

	otherPublic, _ := derivedHPKEKeyPair(t, bytes.Repeat([]byte{0x33}, 32))
	if _, err := OpenResponse(clientPrivate, otherPublic, response); err == nil {
		t.Fatal("authenticated response accepted the wrong provider key")
	}
}

func TestEnvelopeRejectsTamperingAndUnknownFields(t *testing.T) {
	providerPublic, providerPrivate := derivedHPKEKeyPair(t, bytes.Repeat([]byte{0x44}, 32))
	requestID := encodeBinary([]byte("0123456789abcdef"))
	envelope, err := SealRequest(providerPublic, "provider-key", requestID, []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}

	tampered := envelope
	tampered.RequestID = encodeBinary([]byte("fedcba9876543210"))
	if _, err := OpenRequest(providerPrivate, tampered); err == nil {
		t.Fatal("request AAD tampering was accepted")
	}

	ciphertext, _ := decodeBinary(envelope.Ciphertext, 17, maxCiphertext)
	ciphertext[len(ciphertext)-1] ^= 1
	tampered = envelope
	tampered.Ciphertext = encodeBinary(ciphertext)
	if _, err := OpenRequest(providerPrivate, tampered); err == nil {
		t.Fatal("ciphertext tampering was accepted")
	}

	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw[:len(raw)-1], []byte(`,"unexpected":true}`)...)
	if _, err := DecodeRequestEnvelope(raw); err == nil {
		t.Fatal("unknown envelope field was accepted")
	}
}

func derivedHPKEKeyPair(t *testing.T, seed []byte) (publicKey, privateKey []byte) {
	t.Helper()
	public, private := hpke.KEM_X25519_HKDF_SHA256.Scheme().DeriveKeyPair(seed)
	publicKey, err := public.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err = private.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	return publicKey, privateKey
}
