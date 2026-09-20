package protocolv1

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

var errTranscriptField = errors.New("Connect transcript field is too large")

func requestProofInput(message RequestMessage) ([]byte, error) {
	credentialHash := sha256.Sum256([]byte(message.Authorization.Credential))
	bodyHash := sha256.Sum256(message.Body)
	fields := [][]byte{
		[]byte("zerodenet-connect/v1/device-proof"),
		[]byte(message.Operation),
		[]byte(message.RequestID),
		encodeInt64(message.IssuedAt),
		encodeInt64(message.ExpiresAt),
		[]byte(message.SourceID),
		[]byte(message.DeviceID),
		[]byte(message.DevicePublicKey),
		[]byte(message.ResponsePublicKey),
		[]byte(message.Authorization.Kind),
		credentialHash[:],
		bodyHash[:],
	}
	result := make([]byte, 0, 512)
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
