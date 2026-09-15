package domain

import (
	"math"
	"testing"
	"time"
)

func authorizedDevice(t *testing.T) (DeviceRecord, time.Time) {
	t.Helper()
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	device, err := NewPasswordAuthorizedDevice(PasswordAuthorization{
		DeviceID: "device-1", UserID: "user-1", SourceID: "source-1",
		PublicKey: "device-public-key", DisplayName: "Laptop", LoginIP: "203.0.113.7",
	}, Epochs{Global: 3, User: 8}, now)
	if err != nil {
		t.Fatal(err)
	}
	return device, now
}

func TestActivityDoesNotRewritePasswordLoginFacts(t *testing.T) {
	device, now := authorizedDevice(t)
	updated := device.RecordActivity(now.Add(time.Hour))
	if !updated.LastActivityAt.Equal(now.Add(time.Hour)) {
		t.Fatal("activity timestamp was not advanced")
	}
	if !updated.LastPasswordLoginAt.Equal(now) || updated.LastPasswordLoginIP != "203.0.113.7" {
		t.Fatal("periodic activity must not masquerade as a password login")
	}
}

func TestRevocationAndEpochChangesInvalidateSessions(t *testing.T) {
	device, now := authorizedDevice(t)
	session := SessionBinding{
		DeviceID: device.ID, UserID: device.UserID, SourceID: device.SourceID,
		Epochs: device.Epochs, ExpiresAt: now.Add(time.Hour),
	}
	if !device.Accepts(session, device.Epochs, now) {
		t.Fatal("fresh matching session should be accepted")
	}
	if device.Accepts(session, Epochs{Global: 3, User: 9}, now) {
		t.Fatal("user clear must invalidate an older session")
	}
	if device.Accepts(session, Epochs{Global: 4, User: 8}, now) {
		t.Fatal("global clear must invalidate an older session")
	}
	if device.Revoke(now).Accepts(session, device.Epochs, now) {
		t.Fatal("revoked device must not renew or access data")
	}
}

func TestSessionCannotMoveAcrossDeviceUserOrSource(t *testing.T) {
	device, now := authorizedDevice(t)
	base := SessionBinding{DeviceID: device.ID, UserID: device.UserID, SourceID: device.SourceID, Epochs: device.Epochs, ExpiresAt: now.Add(time.Hour)}
	for name, mutate := range map[string]func(*SessionBinding){
		"device": func(value *SessionBinding) { value.DeviceID = "device-2" },
		"user":   func(value *SessionBinding) { value.UserID = "user-2" },
		"source": func(value *SessionBinding) { value.SourceID = "source-2" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := base
			mutate(&changed)
			if device.Accepts(changed, device.Epochs, now) {
				t.Fatal("session binding was accepted after scope substitution")
			}
		})
	}
}

func TestEpochIncrementFailsClosedAtOverflow(t *testing.T) {
	if _, err := IncrementEpoch(math.MaxUint64); err != ErrEpochExhausted {
		t.Fatalf("got %v, want ErrEpochExhausted", err)
	}
}
