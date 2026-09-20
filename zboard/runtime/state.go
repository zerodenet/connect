package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	protocolv1 "github.com/zerodenet/connect/protocol/v1"
	"github.com/zerodenet/connect/zboard/domain"
	pluginv1 "github.com/zerodenet/zboard/backend/pkg/pluginapi/v1"
)

const providerStateKey = "provider-state"
const providerKeyRotationLead = 7 * 24 * time.Hour

var errProviderIDChanged = errors.New("provider_id differs from the initialized provider identity")

type storageClient interface {
	Get(context.Context, string) (pluginv1.StoredValue, error)
	Put(context.Context, string, uint64, json.RawMessage) (pluginv1.StoredValue, error)
	Delete(context.Context, string, uint64) (pluginv1.StoredValue, error)
	Close()
}

type hostClient interface {
	Call(context.Context, string, string, any, any) error
	Close()
}

type sessionRecord struct {
	ID               string        `json:"id"`
	UserID           string        `json:"user_id"`
	DeviceID         string        `json:"device_id"`
	SourceID         string        `json:"source_id"`
	DevicePublicKey  string        `json:"device_public_key"`
	Admin            bool          `json:"admin"`
	Epochs           domain.Epochs `json:"epochs"`
	AccessHash       string        `json:"access_hash"`
	AccessExpiresAt  int64         `json:"access_expires_at"`
	RenewalHash      string        `json:"renewal_hash"`
	RenewalExpiresAt int64         `json:"renewal_expires_at"`
}

type replayRecord struct {
	RequestHash string          `json:"request_hash"`
	Response    json.RawMessage `json:"response,omitempty"`
	RetainUntil int64           `json:"retain_until"`
}

type previousHPKEKey struct {
	KeyID      string `json:"key_id"`
	PublicKey  string `json:"public_key"`
	PrivateKey string `json:"private_key"`
	NotAfter   int64  `json:"not_after"`
}

type responseKey struct {
	ID      string
	Private []byte
}

type providerState struct {
	Version              int                             `json:"version"`
	ProviderID           string                          `json:"provider_id"`
	IdentityKeyID        string                          `json:"identity_key_id"`
	IdentityPublicKey    string                          `json:"identity_public_key"`
	IdentityPrivateKey   string                          `json:"identity_private_key"`
	HPKEKeyID            string                          `json:"hpke_key_id"`
	HPKEPublicKey        string                          `json:"hpke_public_key"`
	HPKEPrivateKey       string                          `json:"hpke_private_key"`
	ProviderKeyStatement protocolv1.ProviderKeyStatement `json:"provider_key_statement"`
	PreviousHPKEKeys     []previousHPKEKey               `json:"previous_hpke_keys,omitempty"`
	GlobalEpoch          uint64                          `json:"global_epoch"`
	UserEpochs           map[string]uint64               `json:"user_epochs"`
	Devices              map[string]domain.DeviceRecord  `json:"devices"`
	Sessions             map[string]sessionRecord        `json:"sessions"`
	MutationReplays      map[string]replayRecord         `json:"mutation_replays"`
	SafeReplays          map[string]int64                `json:"safe_replays"`
}

type loadedState struct {
	value    providerState
	revision uint64
}

func loadProviderState(ctx context.Context, storage storageClient, providerID string, now time.Time) (loadedState, error) {
	stored, err := storage.Get(ctx, providerStateKey)
	if err != nil {
		return loadedState{}, err
	}
	if !stored.Found {
		state, err := newProviderState(providerID, now)
		if err != nil {
			return loadedState{}, err
		}
		loaded := loadedState{value: state, revision: stored.Revision}
		if err := loaded.save(ctx, storage); err != nil {
			return loadedState{}, err
		}
		return loaded, nil
	}
	var state providerState
	if err := json.Unmarshal(stored.Value, &state); err != nil || state.Version != 1 {
		return loadedState{}, errors.New("invalid persisted provider state")
	}
	state.ensureMaps()
	if state.ProviderID != providerID {
		return loadedState{}, errProviderIDChanged
	}
	if err := state.validate(now); err != nil {
		return loadedState{}, err
	}
	loaded := loadedState{value: state, revision: stored.Revision}
	rotated, err := loaded.value.rotateProviderKey(now)
	if err != nil {
		return loadedState{}, err
	}
	if rotated {
		if err := loaded.save(ctx, storage); err != nil {
			return loadedState{}, err
		}
	}
	return loaded, nil
}

func newProviderState(providerID string, now time.Time) (providerState, error) {
	identityPublic, identityPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return providerState{}, err
	}
	hpkePublic, hpkePrivate, err := protocolv1.GenerateHPKEKeyPair()
	if err != nil {
		return providerState{}, err
	}
	identityKeyID := keyID("identity", identityPublic)
	hpkeKeyID := keyID("hpke", hpkePublic)
	notBefore := now.UTC().Add(-protocolv1.ClockSkew).Unix()
	statement := protocolv1.ProviderKeyStatement{
		ProtocolVersion: protocolv1.ProtocolVersion,
		ProviderID:      providerID, IdentityKeyID: identityKeyID, KeyID: hpkeKeyID,
		HPKEPublicKey: encodeBytes(hpkePublic), NotBefore: notBefore,
		NotAfter: notBefore + int64(protocolv1.MaxProviderKeyLifetime/time.Second),
	}
	if err := statement.Sign(identityPrivate); err != nil {
		return providerState{}, err
	}
	state := providerState{
		Version: 1, ProviderID: providerID,
		IdentityKeyID: identityKeyID, IdentityPublicKey: encodeBytes(identityPublic), IdentityPrivateKey: encodeBytes(identityPrivate),
		HPKEKeyID: hpkeKeyID, HPKEPublicKey: encodeBytes(hpkePublic), HPKEPrivateKey: encodeBytes(hpkePrivate),
		ProviderKeyStatement: statement,
	}
	state.ensureMaps()
	return state, nil
}

func (state *providerState) ensureMaps() {
	if state.UserEpochs == nil {
		state.UserEpochs = map[string]uint64{}
	}
	if state.Devices == nil {
		state.Devices = map[string]domain.DeviceRecord{}
	}
	if state.Sessions == nil {
		state.Sessions = map[string]sessionRecord{}
	}
	if state.MutationReplays == nil {
		state.MutationReplays = map[string]replayRecord{}
	}
	if state.SafeReplays == nil {
		state.SafeReplays = map[string]int64{}
	}
}

func (state providerState) validate(_ time.Time) error {
	identityPublic, err := decodeBytes(state.IdentityPublicKey, ed25519.PublicKeySize)
	if err != nil {
		return errors.New("invalid persisted identity public key")
	}
	identityPrivate, err := decodeBytes(state.IdentityPrivateKey, ed25519.PrivateKeySize)
	if err != nil || !ed25519.PrivateKey(identityPrivate).Public().(ed25519.PublicKey).Equal(ed25519.PublicKey(identityPublic)) {
		return errors.New("invalid persisted identity private key")
	}
	hpkePublic, err := decodeBytes(state.HPKEPublicKey, 32)
	if err != nil {
		return errors.New("invalid persisted HPKE public key")
	}
	hpkePrivate, err := decodeBytes(state.HPKEPrivateKey, 32)
	if err != nil {
		return errors.New("invalid persisted HPKE private key")
	}
	derivedPublic, err := protocolv1.HPKEPublicKeyFromPrivate(hpkePrivate)
	if err != nil || !bytes.Equal(derivedPublic, hpkePublic) {
		return errors.New("persisted HPKE key pair does not match")
	}
	statementTime := time.Unix(state.ProviderKeyStatement.NotBefore, 0).Add(time.Second)
	if state.IdentityKeyID == "" || state.HPKEKeyID == "" ||
		state.ProviderKeyStatement.ProviderID != state.ProviderID ||
		state.ProviderKeyStatement.IdentityKeyID != state.IdentityKeyID ||
		state.ProviderKeyStatement.KeyID != state.HPKEKeyID ||
		state.ProviderKeyStatement.HPKEPublicKey != state.HPKEPublicKey ||
		state.ProviderKeyStatement.Verify(ed25519.PublicKey(identityPublic), statementTime) != nil {
		return errors.New("invalid persisted provider key statement")
	}
	for _, previous := range state.PreviousHPKEKeys {
		if previous.KeyID == "" || previous.NotAfter <= 0 {
			return errors.New("invalid previous HPKE key")
		}
		previousPublic, err := decodeBytes(previous.PublicKey, 32)
		if err != nil {
			return errors.New("invalid previous HPKE public key")
		}
		previousPrivate, err := decodeBytes(previous.PrivateKey, 32)
		if err != nil {
			return errors.New("invalid previous HPKE private key")
		}
		derived, err := protocolv1.HPKEPublicKeyFromPrivate(previousPrivate)
		if err != nil || !bytes.Equal(derived, previousPublic) {
			return errors.New("previous HPKE key pair does not match")
		}
	}
	return nil
}

func (state *providerState) rotateProviderKey(now time.Time) (bool, error) {
	changed := false
	kept := state.PreviousHPKEKeys[:0]
	for _, previous := range state.PreviousHPKEKeys {
		if now.Unix() <= previous.NotAfter+int64(protocolv1.ClockSkew/time.Second) {
			kept = append(kept, previous)
		} else {
			changed = true
		}
	}
	state.PreviousHPKEKeys = kept
	if state.ProviderKeyStatement.NotAfter > now.Add(providerKeyRotationLead).Unix() {
		return changed, nil
	}
	state.PreviousHPKEKeys = append(state.PreviousHPKEKeys, previousHPKEKey{
		KeyID: state.HPKEKeyID, PublicKey: state.HPKEPublicKey, PrivateKey: state.HPKEPrivateKey,
		NotAfter: state.ProviderKeyStatement.NotAfter,
	})
	publicKey, privateKey, err := protocolv1.GenerateHPKEKeyPair()
	if err != nil {
		return false, err
	}
	identityPrivate, err := decodeBytes(state.IdentityPrivateKey, ed25519.PrivateKeySize)
	if err != nil {
		return false, err
	}
	notBefore := now.UTC().Add(-protocolv1.ClockSkew).Unix()
	statement := protocolv1.ProviderKeyStatement{
		ProtocolVersion: protocolv1.ProtocolVersion, ProviderID: state.ProviderID,
		IdentityKeyID: state.IdentityKeyID, KeyID: keyID("hpke", publicKey), HPKEPublicKey: encodeBytes(publicKey),
		NotBefore: notBefore, NotAfter: notBefore + int64(protocolv1.MaxProviderKeyLifetime/time.Second),
	}
	if err := statement.Sign(ed25519.PrivateKey(identityPrivate)); err != nil {
		return false, err
	}
	state.HPKEKeyID, state.HPKEPublicKey, state.HPKEPrivateKey = statement.KeyID, statement.HPKEPublicKey, encodeBytes(privateKey)
	state.ProviderKeyStatement = statement
	return true, nil
}

func (state providerState) responseKey(keyID string, now time.Time) (responseKey, bool) {
	if keyID == state.HPKEKeyID {
		privateKey, err := decodeBytes(state.HPKEPrivateKey, 32)
		return responseKey{ID: keyID, Private: privateKey}, err == nil
	}
	for _, previous := range state.PreviousHPKEKeys {
		if previous.KeyID == keyID && now.Unix() <= previous.NotAfter+int64(protocolv1.ClockSkew/time.Second) {
			privateKey, err := decodeBytes(previous.PrivateKey, 32)
			return responseKey{ID: keyID, Private: privateKey}, err == nil
		}
	}
	return responseKey{}, false
}

func (loaded *loadedState) save(ctx context.Context, storage storageClient) error {
	raw, err := json.Marshal(loaded.value)
	if err != nil {
		return err
	}
	stored, err := storage.Put(ctx, providerStateKey, loaded.revision, raw)
	if err != nil {
		return err
	}
	loaded.revision = stored.Revision
	return nil
}

func (state *providerState) prune(now time.Time) bool {
	changed := false
	for id, session := range state.Sessions {
		if session.RenewalExpiresAt <= now.Unix() {
			delete(state.Sessions, id)
			changed = true
		}
	}
	for key, replay := range state.MutationReplays {
		if replay.RetainUntil <= now.Unix() {
			delete(state.MutationReplays, key)
			changed = true
		}
	}
	return changed
}

func keyID(prefix string, publicKey []byte) string {
	digest := sha256.Sum256(publicKey)
	return prefix + "-" + hex.EncodeToString(digest[:8])
}

func randomSecret() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return encodeBytes(value), nil
}

func hashString(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func encodeBytes(value []byte) string { return base64.RawURLEncoding.EncodeToString(value) }

func decodeBytes(value string, size int) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != size || encodeBytes(decoded) != value {
		return nil, fmt.Errorf("invalid encoded key")
	}
	return decoded, nil
}

func mutationReplayKey(keyID, requestID string) string { return keyID + ":" + requestID }

func safeReplayStorageKey(keyID, requestID string) string {
	digest := sha256.Sum256([]byte(keyID + "\x00" + requestID))
	return "replay-" + hex.EncodeToString(digest[:])
}
