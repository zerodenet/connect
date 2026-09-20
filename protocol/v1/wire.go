package protocolv1

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/cloudflare/circl/hpke"
)

const (
	ProtocolVersion = 1
	SuiteID         = "HPKE-0x0020-0x0001-0x0003"
	MaxPlaintext    = 5 << 20
	maxCiphertext   = MaxPlaintext + 16
)

var (
	errInvalidEnvelope = errors.New("invalid Connect envelope")
	suite              = hpke.NewSuite(
		hpke.KEM_X25519_HKDF_SHA256,
		hpke.KDF_HKDF_SHA256,
		hpke.AEAD_ChaCha20Poly1305,
	)
)

type RequestEnvelope struct {
	ProtocolVersion int    `json:"protocol_version"`
	Suite           string `json:"suite"`
	KeyID           string `json:"key_id"`
	RequestID       string `json:"request_id"`
	Encapsulation   string `json:"encapsulation"`
	Ciphertext      string `json:"ciphertext"`
}

type ResponseEnvelope struct {
	ProtocolVersion int    `json:"protocol_version"`
	Suite           string `json:"suite"`
	KeyID           string `json:"key_id"`
	RequestID       string `json:"request_id"`
	Encapsulation   string `json:"encapsulation"`
	Ciphertext      string `json:"ciphertext"`
}

func GenerateHPKEKeyPair() (publicKey, privateKey []byte, err error) {
	public, private, err := hpke.KEM_X25519_HKDF_SHA256.Scheme().GenerateKeyPair()
	if err != nil {
		return nil, nil, err
	}
	publicBytes, err := public.MarshalBinary()
	if err != nil {
		return nil, nil, err
	}
	privateBytes, err := private.MarshalBinary()
	if err != nil {
		return nil, nil, err
	}
	return publicBytes, privateBytes, nil
}

func HPKEPublicKeyFromPrivate(privateKey []byte) ([]byte, error) {
	private, err := hpke.KEM_X25519_HKDF_SHA256.Scheme().UnmarshalBinaryPrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("provider HPKE private key: %w", err)
	}
	public, err := private.Public().MarshalBinary()
	if err != nil {
		return nil, err
	}
	return public, nil
}

func SealRequest(providerPublicKey []byte, keyID, requestID string, plaintext []byte) (RequestEnvelope, error) {
	return sealRequest(providerPublicKey, keyID, requestID, plaintext, nil)
}

func sealRequest(providerPublicKey []byte, keyID, requestID string, plaintext []byte, random io.Reader) (RequestEnvelope, error) {
	if err := validateMetadata(keyID, requestID); err != nil || len(plaintext) == 0 || len(plaintext) > MaxPlaintext {
		return RequestEnvelope{}, errInvalidEnvelope
	}
	public, err := hpke.KEM_X25519_HKDF_SHA256.Scheme().UnmarshalBinaryPublicKey(providerPublicKey)
	if err != nil {
		return RequestEnvelope{}, fmt.Errorf("provider HPKE public key: %w", err)
	}
	sender, err := suite.NewSender(public, requestInfo(keyID))
	if err != nil {
		return RequestEnvelope{}, err
	}
	encapsulation, sealer, err := sender.Setup(random)
	if err != nil {
		return RequestEnvelope{}, err
	}
	ciphertext, err := sealer.Seal(plaintext, requestAAD(keyID, requestID))
	if err != nil {
		return RequestEnvelope{}, err
	}
	return RequestEnvelope{
		ProtocolVersion: ProtocolVersion,
		Suite:           SuiteID,
		KeyID:           keyID,
		RequestID:       requestID,
		Encapsulation:   encodeBinary(encapsulation),
		Ciphertext:      encodeBinary(ciphertext),
	}, nil
}

func OpenRequest(providerPrivateKey []byte, envelope RequestEnvelope) ([]byte, error) {
	encapsulation, ciphertext, err := validateRequestEnvelope(envelope)
	if err != nil {
		return nil, err
	}
	private, err := hpke.KEM_X25519_HKDF_SHA256.Scheme().UnmarshalBinaryPrivateKey(providerPrivateKey)
	if err != nil {
		return nil, fmt.Errorf("provider HPKE private key: %w", err)
	}
	receiver, err := suite.NewReceiver(private, requestInfo(envelope.KeyID))
	if err != nil {
		return nil, err
	}
	opener, err := receiver.Setup(encapsulation)
	if err != nil {
		return nil, err
	}
	plaintext, err := opener.Open(ciphertext, requestAAD(envelope.KeyID, envelope.RequestID))
	if err != nil {
		return nil, errors.New("request authentication failed")
	}
	return plaintext, nil
}

// SealResponse uses HPKE authenticated mode. The client verifies that the
// sender owns the provider key selected by keyID, which is pinned through the
// signed provider key statement.
func SealResponse(providerPrivateKey, clientResponsePublicKey []byte, keyID, requestID string, plaintext []byte) (ResponseEnvelope, error) {
	return sealResponse(providerPrivateKey, clientResponsePublicKey, keyID, requestID, plaintext, nil)
}

func sealResponse(providerPrivateKey, clientResponsePublicKey []byte, keyID, requestID string, plaintext []byte, random io.Reader) (ResponseEnvelope, error) {
	if err := validateMetadata(keyID, requestID); err != nil || len(plaintext) == 0 || len(plaintext) > MaxPlaintext {
		return ResponseEnvelope{}, errInvalidEnvelope
	}
	scheme := hpke.KEM_X25519_HKDF_SHA256.Scheme()
	providerPrivate, err := scheme.UnmarshalBinaryPrivateKey(providerPrivateKey)
	if err != nil {
		return ResponseEnvelope{}, fmt.Errorf("provider HPKE private key: %w", err)
	}
	clientPublic, err := scheme.UnmarshalBinaryPublicKey(clientResponsePublicKey)
	if err != nil {
		return ResponseEnvelope{}, fmt.Errorf("client response public key: %w", err)
	}
	sender, err := suite.NewSender(clientPublic, responseInfo(keyID))
	if err != nil {
		return ResponseEnvelope{}, err
	}
	encapsulation, sealer, err := sender.SetupAuth(random, providerPrivate)
	if err != nil {
		return ResponseEnvelope{}, err
	}
	ciphertext, err := sealer.Seal(plaintext, responseAAD(keyID, requestID))
	if err != nil {
		return ResponseEnvelope{}, err
	}
	return ResponseEnvelope{
		ProtocolVersion: ProtocolVersion,
		Suite:           SuiteID,
		KeyID:           keyID,
		RequestID:       requestID,
		Encapsulation:   encodeBinary(encapsulation),
		Ciphertext:      encodeBinary(ciphertext),
	}, nil
}

func OpenResponse(clientResponsePrivateKey, providerPublicKey []byte, envelope ResponseEnvelope) ([]byte, error) {
	encapsulation, ciphertext, err := validateResponseEnvelope(envelope)
	if err != nil {
		return nil, err
	}
	scheme := hpke.KEM_X25519_HKDF_SHA256.Scheme()
	clientPrivate, err := scheme.UnmarshalBinaryPrivateKey(clientResponsePrivateKey)
	if err != nil {
		return nil, fmt.Errorf("client response private key: %w", err)
	}
	providerPublic, err := scheme.UnmarshalBinaryPublicKey(providerPublicKey)
	if err != nil {
		return nil, fmt.Errorf("provider HPKE public key: %w", err)
	}
	receiver, err := suite.NewReceiver(clientPrivate, responseInfo(envelope.KeyID))
	if err != nil {
		return nil, err
	}
	opener, err := receiver.SetupAuth(encapsulation, providerPublic)
	if err != nil {
		return nil, err
	}
	plaintext, err := opener.Open(ciphertext, responseAAD(envelope.KeyID, envelope.RequestID))
	if err != nil {
		return nil, errors.New("response authentication failed")
	}
	return plaintext, nil
}

func DecodeRequestEnvelope(raw []byte) (RequestEnvelope, error) {
	var envelope RequestEnvelope
	if err := decodeStrict(raw, &envelope); err != nil {
		return RequestEnvelope{}, err
	}
	if _, _, err := validateRequestEnvelope(envelope); err != nil {
		return RequestEnvelope{}, err
	}
	return envelope, nil
}

func DecodeResponseEnvelope(raw []byte) (ResponseEnvelope, error) {
	var envelope ResponseEnvelope
	if err := decodeStrict(raw, &envelope); err != nil {
		return ResponseEnvelope{}, err
	}
	if _, _, err := validateResponseEnvelope(envelope); err != nil {
		return ResponseEnvelope{}, err
	}
	return envelope, nil
}

func validateRequestEnvelope(envelope RequestEnvelope) ([]byte, []byte, error) {
	return validateEnvelope(envelope.ProtocolVersion, envelope.Suite, envelope.KeyID, envelope.RequestID, envelope.Encapsulation, envelope.Ciphertext)
}

func validateResponseEnvelope(envelope ResponseEnvelope) ([]byte, []byte, error) {
	return validateEnvelope(envelope.ProtocolVersion, envelope.Suite, envelope.KeyID, envelope.RequestID, envelope.Encapsulation, envelope.Ciphertext)
}

func validateEnvelope(version int, suiteID, keyID, requestID, encodedEncapsulation, encodedCiphertext string) ([]byte, []byte, error) {
	if version != ProtocolVersion || suiteID != SuiteID || validateMetadata(keyID, requestID) != nil {
		return nil, nil, errInvalidEnvelope
	}
	encapsulation, err := decodeBinary(encodedEncapsulation, 32, 32)
	if err != nil {
		return nil, nil, errInvalidEnvelope
	}
	ciphertext, err := decodeBinary(encodedCiphertext, 17, maxCiphertext)
	if err != nil {
		return nil, nil, errInvalidEnvelope
	}
	return encapsulation, ciphertext, nil
}

func validateMetadata(keyID, requestID string) error {
	if !identifier(keyID, 64) {
		return errInvalidEnvelope
	}
	decoded, err := base64.RawURLEncoding.DecodeString(requestID)
	if err != nil || len(decoded) != 16 || encodeBinary(decoded) != requestID {
		return errInvalidEnvelope
	}
	return nil
}

func identifier(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, value := range []byte(value) {
		if !(value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || strings.ContainsRune("._-", rune(value))) {
			return false
		}
	}
	return true
}

func requestInfo(keyID string) []byte {
	return []byte("zerodenet-connect/v1/request/" + keyID)
}

func responseInfo(keyID string) []byte {
	return []byte("zerodenet-connect/v1/response/" + keyID)
}

func requestAAD(keyID, requestID string) []byte {
	return []byte("zerodenet-connect/v1/request\x00" + keyID + "\x00" + requestID)
}

func responseAAD(keyID, requestID string) []byte {
	return []byte("zerodenet-connect/v1/response\x00" + keyID + "\x00" + requestID)
}

func encodeBinary(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func decodeBinary(value string, minimum, maximum int) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) < minimum || len(decoded) > maximum || encodeBinary(decoded) != value {
		return nil, errInvalidEnvelope
	}
	return decoded, nil
}

func decodeStrict(raw []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return errInvalidEnvelope
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errInvalidEnvelope
	}
	return nil
}
