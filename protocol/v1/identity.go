package protocolv1

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"net/url"
	"time"
)

const MaxProviderKeyLifetime = 90 * 24 * time.Hour

var ErrInvalidIdentityStatement = errors.New("invalid Connect identity statement")

type ProviderKeyStatement struct {
	ProtocolVersion int    `json:"protocol_version"`
	ProviderID      string `json:"provider_id"`
	IdentityKeyID   string `json:"identity_key_id"`
	KeyID           string `json:"key_id"`
	HPKEPublicKey   string `json:"hpke_public_key"`
	NotBefore       int64  `json:"not_before"`
	NotAfter        int64  `json:"not_after"`
	Signature       string `json:"signature"`
}

type IdentityRotationStatement struct {
	ProtocolVersion  int    `json:"protocol_version"`
	ProviderID       string `json:"provider_id"`
	OldIdentityKeyID string `json:"old_identity_key_id"`
	NewIdentityKeyID string `json:"new_identity_key_id"`
	NewPublicKey     string `json:"new_public_key"`
	NotBefore        int64  `json:"not_before"`
	OldSignature     string `json:"old_signature"`
	NewSignature     string `json:"new_signature"`
}

func (statement *ProviderKeyStatement) Sign(identityPrivateKey ed25519.PrivateKey) error {
	if len(identityPrivateKey) != ed25519.PrivateKeySize {
		return ErrInvalidIdentityStatement
	}
	input, err := providerKeyStatementInput(*statement)
	if err != nil {
		return err
	}
	statement.Signature = encodeBinary(ed25519.Sign(identityPrivateKey, input))
	return nil
}

func (statement ProviderKeyStatement) Verify(identityPublicKey ed25519.PublicKey, now time.Time) error {
	if len(identityPublicKey) != ed25519.PublicKeySize || validateProviderKeyStatement(statement, now) != nil {
		return ErrInvalidIdentityStatement
	}
	signature, err := decodeBinary(statement.Signature, ed25519.SignatureSize, ed25519.SignatureSize)
	if err != nil {
		return ErrInvalidIdentityStatement
	}
	input, err := providerKeyStatementInput(statement)
	if err != nil || !ed25519.Verify(identityPublicKey, input, signature) {
		return ErrInvalidIdentityStatement
	}
	return nil
}

func (statement *IdentityRotationStatement) Sign(oldPrivateKey, newPrivateKey ed25519.PrivateKey) error {
	if len(oldPrivateKey) != ed25519.PrivateKeySize || len(newPrivateKey) != ed25519.PrivateKeySize {
		return ErrInvalidIdentityStatement
	}
	newPublicKey := newPrivateKey.Public().(ed25519.PublicKey)
	statement.NewPublicKey = encodeBinary(newPublicKey)
	input, err := identityRotationInput(*statement)
	if err != nil {
		return err
	}
	statement.OldSignature = encodeBinary(ed25519.Sign(oldPrivateKey, input))
	statement.NewSignature = encodeBinary(ed25519.Sign(newPrivateKey, input))
	return nil
}

func (statement IdentityRotationStatement) Verify(oldPublicKey ed25519.PublicKey, now time.Time) (ed25519.PublicKey, error) {
	if len(oldPublicKey) != ed25519.PublicKeySize || statement.ProtocolVersion != ProtocolVersion ||
		!validProviderID(statement.ProviderID) || !identifier(statement.OldIdentityKeyID, 64) ||
		!identifier(statement.NewIdentityKeyID, 64) || statement.OldIdentityKeyID == statement.NewIdentityKeyID ||
		statement.NotBefore <= 0 || now.Unix()+int64(ClockSkew/time.Second) < statement.NotBefore {
		return nil, ErrInvalidIdentityStatement
	}
	newPublicKey, err := decodeBinary(statement.NewPublicKey, ed25519.PublicKeySize, ed25519.PublicKeySize)
	if err != nil {
		return nil, ErrInvalidIdentityStatement
	}
	oldSignature, err := decodeBinary(statement.OldSignature, ed25519.SignatureSize, ed25519.SignatureSize)
	if err != nil {
		return nil, ErrInvalidIdentityStatement
	}
	newSignature, err := decodeBinary(statement.NewSignature, ed25519.SignatureSize, ed25519.SignatureSize)
	if err != nil {
		return nil, ErrInvalidIdentityStatement
	}
	input, err := identityRotationInput(statement)
	if err != nil || !ed25519.Verify(oldPublicKey, input, oldSignature) || !ed25519.Verify(newPublicKey, input, newSignature) {
		return nil, ErrInvalidIdentityStatement
	}
	return ed25519.PublicKey(newPublicKey), nil
}

func IdentityFingerprint(publicKey ed25519.PublicKey) (string, error) {
	if len(publicKey) != ed25519.PublicKeySize {
		return "", ErrInvalidIdentityStatement
	}
	digest := sha256.Sum256(publicKey)
	return encodeBinary(digest[:]), nil
}

func validateProviderKeyStatement(statement ProviderKeyStatement, now time.Time) error {
	if statement.ProtocolVersion != ProtocolVersion || !validProviderID(statement.ProviderID) ||
		!identifier(statement.IdentityKeyID, 64) || !identifier(statement.KeyID, 64) {
		return ErrInvalidIdentityStatement
	}
	if _, err := decodeBinary(statement.HPKEPublicKey, 32, 32); err != nil {
		return ErrInvalidIdentityStatement
	}
	if statement.NotBefore <= 0 || statement.NotAfter <= statement.NotBefore ||
		time.Duration(statement.NotAfter-statement.NotBefore)*time.Second > MaxProviderKeyLifetime {
		return ErrInvalidIdentityStatement
	}
	nowUnix := now.Unix()
	if nowUnix < statement.NotBefore-int64(ClockSkew/time.Second) || nowUnix > statement.NotAfter+int64(ClockSkew/time.Second) {
		return ErrInvalidIdentityStatement
	}
	return nil
}

func providerKeyStatementInput(statement ProviderKeyStatement) ([]byte, error) {
	return identityTranscript("zerodenet-connect/v1/provider-key", [][]byte{
		[]byte(statement.ProviderID), []byte(statement.IdentityKeyID), []byte(statement.KeyID),
		[]byte(statement.HPKEPublicKey), encodeInt64(statement.NotBefore), encodeInt64(statement.NotAfter),
	})
}

func identityRotationInput(statement IdentityRotationStatement) ([]byte, error) {
	return identityTranscript("zerodenet-connect/v1/identity-rotation", [][]byte{
		[]byte(statement.ProviderID), []byte(statement.OldIdentityKeyID), []byte(statement.NewIdentityKeyID),
		[]byte(statement.NewPublicKey), encodeInt64(statement.NotBefore),
	})
}

func identityTranscript(domain string, fields [][]byte) ([]byte, error) {
	result := make([]byte, 0, 512)
	fields = append([][]byte{[]byte(domain)}, fields...)
	for _, field := range fields {
		if uint64(len(field)) > uint64(^uint32(0)) {
			return nil, errTranscriptField
		}
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(len(field)))
		result = append(result, length[:]...)
		result = append(result, field...)
	}
	return result, nil
}

func encodeInt64(value int64) []byte {
	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], uint64(value))
	return encoded[:]
}

func validProviderID(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil &&
		parsed.Path == "" && parsed.RawPath == "" && parsed.RawQuery == "" && parsed.Fragment == ""
}
