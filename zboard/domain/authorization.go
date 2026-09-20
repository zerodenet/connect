package domain

import (
	"errors"
	"math"
	"strings"
	"time"
)

var ErrInvalidAuthorization = errors.New("invalid authorization data")
var ErrEpochExhausted = errors.New("authorization epoch exhausted")

type Epochs struct {
	Global uint64
	User   uint64
}

type DeviceRecord struct {
	ID                  string
	UserID              string
	SourceID            string
	PublicKey           string
	DisplayName         string
	Epochs              Epochs
	AuthorizedAt        time.Time
	LastPasswordLoginAt time.Time
	LastPasswordLoginIP string
	LastActivityAt      time.Time
	RevokedAt           *time.Time
}

type SessionBinding struct {
	DeviceID  string
	UserID    string
	SourceID  string
	Epochs    Epochs
	ExpiresAt time.Time
}

type PasswordAuthorization struct {
	DeviceID    string
	UserID      string
	SourceID    string
	PublicKey   string
	DisplayName string
	LoginIP     string
}

func NewPasswordAuthorizedDevice(input PasswordAuthorization, epochs Epochs, now time.Time) (DeviceRecord, error) {
	if blank(input.DeviceID) || blank(input.UserID) || blank(input.SourceID) || blank(input.PublicKey) || now.IsZero() {
		return DeviceRecord{}, ErrInvalidAuthorization
	}
	return DeviceRecord{
		ID:                  input.DeviceID,
		UserID:              input.UserID,
		SourceID:            input.SourceID,
		PublicKey:           input.PublicKey,
		DisplayName:         strings.TrimSpace(input.DisplayName),
		Epochs:              epochs,
		AuthorizedAt:        now,
		LastPasswordLoginAt: now,
		LastPasswordLoginIP: input.LoginIP,
		LastActivityAt:      now,
	}, nil
}

func (device DeviceRecord) RecordActivity(now time.Time) DeviceRecord {
	if now.After(device.LastActivityAt) {
		device.LastActivityAt = now
	}
	return device
}

func (device DeviceRecord) Revoke(now time.Time) DeviceRecord {
	if device.RevokedAt == nil {
		value := now
		device.RevokedAt = &value
	}
	return device
}

func (device DeviceRecord) Accepts(session SessionBinding, current Epochs, now time.Time) bool {
	return device.RevokedAt == nil &&
		device.ID == session.DeviceID &&
		device.UserID == session.UserID &&
		device.SourceID == session.SourceID &&
		device.Epochs == session.Epochs &&
		session.Epochs == current &&
		now.Before(session.ExpiresAt)
}

func IncrementEpoch(value uint64) (uint64, error) {
	if value == math.MaxUint64 {
		return 0, ErrEpochExhausted
	}
	return value + 1, nil
}

func blank(value string) bool { return strings.TrimSpace(value) == "" }
