package protocolv1

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const (
	MaxRequestLifetime = 2 * time.Minute
	ClockSkew          = 30 * time.Second
)

var (
	ErrInvalidMessage = errors.New("invalid Connect message")
	ErrExpiredMessage = errors.New("expired Connect message")
	ErrInvalidProof   = errors.New("invalid Connect device proof")
)

type Authorization struct {
	Kind       string `json:"kind"`
	Credential string `json:"credential"`
}

type RequestMessage struct {
	ProtocolVersion   int             `json:"protocol_version"`
	Operation         string          `json:"operation"`
	RequestID         string          `json:"request_id"`
	IssuedAt          int64           `json:"issued_at"`
	ExpiresAt         int64           `json:"expires_at"`
	SourceID          string          `json:"source_id"`
	DeviceID          string          `json:"device_id"`
	DevicePublicKey   string          `json:"device_public_key"`
	ResponsePublicKey string          `json:"response_public_key"`
	Authorization     Authorization   `json:"authorization"`
	Body              json.RawMessage `json:"body"`
	DeviceProof       string          `json:"device_proof"`
}

type ResponseError struct {
	Code       string `json:"code"`
	RetryAfter int64  `json:"retry_after,omitempty"`
}

type ResponseMessage struct {
	ProtocolVersion int             `json:"protocol_version"`
	Operation       string          `json:"operation"`
	RequestID       string          `json:"request_id"`
	IssuedAt        int64           `json:"issued_at"`
	ExpiresAt       int64           `json:"expires_at"`
	Status          string          `json:"status"`
	Body            json.RawMessage `json:"body,omitempty"`
	Error           *ResponseError  `json:"error,omitempty"`
}

func (message *RequestMessage) Sign(privateKey ed25519.PrivateKey) error {
	if len(privateKey) != ed25519.PrivateKeySize {
		return ErrInvalidProof
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)
	message.DevicePublicKey = encodeBinary(publicKey)
	input, err := requestProofInput(*message)
	if err != nil {
		return err
	}
	message.DeviceProof = encodeBinary(ed25519.Sign(privateKey, input))
	return nil
}

func (message RequestMessage) Verify(now time.Time) error {
	if err := validateRequestFields(message, now); err != nil {
		return err
	}
	publicKey, err := decodeBinary(message.DevicePublicKey, ed25519.PublicKeySize, ed25519.PublicKeySize)
	if err != nil {
		return ErrInvalidProof
	}
	signature, err := decodeBinary(message.DeviceProof, ed25519.SignatureSize, ed25519.SignatureSize)
	if err != nil {
		return ErrInvalidProof
	}
	input, err := requestProofInput(message)
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey, input, signature) {
		return ErrInvalidProof
	}
	return nil
}

func DecodeRequestMessage(raw []byte, now time.Time) (RequestMessage, error) {
	var message RequestMessage
	if err := decodeStrict(raw, &message); err != nil {
		return RequestMessage{}, ErrInvalidMessage
	}
	if err := message.Verify(now); err != nil {
		return RequestMessage{}, err
	}
	return message, nil
}

func SealRequestMessage(providerPublicKey []byte, keyID string, message RequestMessage, devicePrivateKey ed25519.PrivateKey) (RequestEnvelope, error) {
	if err := message.Sign(devicePrivateKey); err != nil {
		return RequestEnvelope{}, err
	}
	if err := message.Verify(time.Unix(message.IssuedAt, 0)); err != nil {
		return RequestEnvelope{}, err
	}
	raw, err := json.Marshal(message)
	if err != nil {
		return RequestEnvelope{}, err
	}
	return SealRequest(providerPublicKey, keyID, message.RequestID, raw)
}

func OpenRequestMessage(providerPrivateKey []byte, envelope RequestEnvelope, now time.Time) (RequestMessage, error) {
	raw, err := OpenRequest(providerPrivateKey, envelope)
	if err != nil {
		return RequestMessage{}, err
	}
	message, err := DecodeRequestMessage(raw, now)
	if err != nil {
		return RequestMessage{}, err
	}
	if message.RequestID != envelope.RequestID {
		return RequestMessage{}, ErrInvalidMessage
	}
	return message, nil
}

func DecodeResponseMessage(raw []byte, now time.Time, operation, requestID string) (ResponseMessage, error) {
	var message ResponseMessage
	if err := decodeStrict(raw, &message); err != nil {
		return ResponseMessage{}, ErrInvalidMessage
	}
	if err := validateResponseFields(message, now, operation, requestID); err != nil {
		return ResponseMessage{}, err
	}
	return message, nil
}

func SealResponseMessage(providerPrivateKey, clientResponsePublicKey []byte, keyID string, message ResponseMessage) (ResponseEnvelope, error) {
	if err := validateResponseFields(message, time.Unix(message.IssuedAt, 0), message.Operation, message.RequestID); err != nil {
		return ResponseEnvelope{}, err
	}
	raw, err := json.Marshal(message)
	if err != nil {
		return ResponseEnvelope{}, err
	}
	return SealResponse(providerPrivateKey, clientResponsePublicKey, keyID, message.RequestID, raw)
}

func OpenResponseMessage(clientResponsePrivateKey, providerPublicKey []byte, envelope ResponseEnvelope, now time.Time, operation string) (ResponseMessage, error) {
	raw, err := OpenResponse(clientResponsePrivateKey, providerPublicKey, envelope)
	if err != nil {
		return ResponseMessage{}, err
	}
	return DecodeResponseMessage(raw, now, operation, envelope.RequestID)
}

func validateRequestFields(message RequestMessage, now time.Time) error {
	if message.ProtocolVersion != ProtocolVersion || !operationExists(message.Operation) || message.Operation == "capabilities.get" {
		return ErrInvalidMessage
	}
	if validateMetadata("request", message.RequestID) != nil || !identifier(message.SourceID, 128) || !identifier(message.DeviceID, 128) {
		return ErrInvalidMessage
	}
	if _, err := decodeBinary(message.ResponsePublicKey, 32, 32); err != nil {
		return ErrInvalidMessage
	}
	if !validAuthorization(message.Operation, message.Authorization) || !validJSONBody(message.Body) {
		return ErrInvalidMessage
	}
	return validateWindow(message.IssuedAt, message.ExpiresAt, now)
}

func validateResponseFields(message ResponseMessage, now time.Time, operation, requestID string) error {
	if message.ProtocolVersion != ProtocolVersion || message.Operation != operation || message.RequestID != requestID {
		return ErrInvalidMessage
	}
	if message.Status != "ok" && message.Status != "error" {
		return ErrInvalidMessage
	}
	if message.Status == "ok" {
		if message.Error != nil || !validJSONBody(message.Body) {
			return ErrInvalidMessage
		}
	} else if message.Error == nil || !publicErrorExists(message.Error.Code) || len(message.Body) != 0 {
		return ErrInvalidMessage
	}
	return validateWindow(message.IssuedAt, message.ExpiresAt, now)
}

func validateWindow(issuedAt, expiresAt int64, now time.Time) error {
	if issuedAt <= 0 || expiresAt <= issuedAt || time.Duration(expiresAt-issuedAt)*time.Second > MaxRequestLifetime {
		return ErrInvalidMessage
	}
	nowUnix := now.Unix()
	if nowUnix < issuedAt-int64(ClockSkew/time.Second) || nowUnix > expiresAt+int64(ClockSkew/time.Second) {
		return ErrExpiredMessage
	}
	return nil
}

func validAuthorization(operation string, authorization Authorization) bool {
	expected := sessionForOperation(operation)
	if operation == "authorization.password" {
		expected = "password"
	}
	return authorization.Kind == expected && authorization.Credential != "" && len(authorization.Credential) <= 8192
}

func validJSONBody(body json.RawMessage) bool {
	if len(body) == 0 || len(body) > MaxPlaintext || !json.Valid(body) {
		return false
	}
	var value any
	return json.Unmarshal(body, &value) == nil && value != nil
}

func operationExists(operation string) bool {
	for _, candidate := range mustContract().Operations {
		if candidate.ID == operation {
			return true
		}
	}
	return false
}

func sessionForOperation(operation string) string {
	for _, candidate := range mustContract().Operations {
		if candidate.ID == operation {
			return candidate.Session
		}
	}
	return ""
}

func publicErrorExists(code string) bool {
	for _, candidate := range mustContract().Errors {
		if candidate == code {
			return true
		}
	}
	return false
}

func mustContract() Contract {
	contract, err := Load()
	if err != nil {
		panic(fmt.Sprintf("embedded Connect contract is invalid: %v", err))
	}
	return contract
}
