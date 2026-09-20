package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	protocolv1 "github.com/zerodenet/connect/protocol/v1"
	"github.com/zerodenet/connect/zboard/domain"
	pluginv1 "github.com/zerodenet/zboard/backend/pkg/pluginapi/v1"
)

const (
	accessLifetime  = 15 * time.Minute
	renewalLifetime = 30 * 24 * time.Hour
)

type passwordBody struct {
	Account    string `json:"account"`
	DeviceName string `json:"device_name"`
}

type revokeBody struct {
	DeviceID string `json:"device_id"`
}

func (runtime *connectRuntime) authorizePassword(ctx context.Context, state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	var body passwordBody
	if decodeBody(request.Body, &body) != nil || strings.TrimSpace(body.Account) == "" || len(body.Account) > 128 || len(body.DeviceName) > 80 {
		return nil, "invalid_request"
	}
	host, err := runtime.openHost()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	defer host.Close()
	var principal pluginv1.Principal
	err = host.Call(ctx, pluginv1.AccountAssertionCapability, "account.assert", pluginv1.AccountAssertionRequest{
		Account: body.Account, Password: request.Authorization.Credential,
	}, &principal)
	if err != nil {
		return nil, hostErrorCode(err)
	}
	if principal.ID == "" {
		return nil, "temporary_unavailable"
	}
	if existing, ok := state.Devices[request.DeviceID]; ok && (existing.UserID != principal.ID || existing.SourceID != request.SourceID || existing.PublicKey != request.DevicePublicKey) {
		return nil, "conflict"
	}
	epochs := domain.Epochs{Global: state.GlobalEpoch, User: state.UserEpochs[principal.ID]}
	device, err := domain.NewPasswordAuthorizedDevice(domain.PasswordAuthorization{
		DeviceID: request.DeviceID, UserID: principal.ID, SourceID: request.SourceID,
		PublicKey: request.DevicePublicKey, DisplayName: body.DeviceName,
	}, epochs, now)
	if err != nil {
		return nil, "invalid_request"
	}
	state.Devices[device.ID] = device
	for id, session := range state.Sessions {
		if session.DeviceID == device.ID {
			delete(state.Sessions, id)
		}
	}
	return runtime.issueSession(state, device, principal.Admin, now)
}

func (runtime *connectRuntime) issueSession(state *providerState, device domain.DeviceRecord, admin bool, now time.Time) (any, string) {
	access, err := randomSecret()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	renewal, err := randomSecret()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	sessionID, err := randomSecret()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	session := sessionRecord{
		ID: sessionID, UserID: device.UserID, DeviceID: device.ID, SourceID: device.SourceID,
		DevicePublicKey: device.PublicKey, Admin: admin, Epochs: device.Epochs,
		AccessHash: hashString(access), AccessExpiresAt: now.Add(accessLifetime).Unix(),
		RenewalHash: hashString(renewal), RenewalExpiresAt: now.Add(renewalLifetime).Unix(),
	}
	state.Sessions[session.ID] = session
	return map[string]any{
		"user_id": device.UserID, "device_id": device.ID,
		"access_credential": access, "access_expires_at": session.AccessExpiresAt,
		"renewal_credential": renewal, "renewal_expires_at": session.RenewalExpiresAt,
	}, ""
}

func (runtime *connectRuntime) renewAuthorization(state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	if !requireEmptyBody(request.Body) {
		return nil, "invalid_request"
	}
	id, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	access, err := randomSecret()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	renewal, err := randomSecret()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	session.AccessHash = hashString(access)
	session.AccessExpiresAt = now.Add(accessLifetime).Unix()
	session.RenewalHash = hashString(renewal)
	session.RenewalExpiresAt = now.Add(renewalLifetime).Unix()
	state.Sessions[id] = session
	device := state.Devices[session.DeviceID].RecordActivity(now)
	state.Devices[session.DeviceID] = device
	return map[string]any{
		"user_id": session.UserID, "device_id": session.DeviceID,
		"access_credential": access, "access_expires_at": session.AccessExpiresAt,
		"renewal_credential": renewal, "renewal_expires_at": session.RenewalExpiresAt,
	}, ""
}

func (runtime *connectRuntime) revokeDevice(state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	var body revokeBody
	if decodeBody(request.Body, &body) != nil || strings.TrimSpace(body.DeviceID) == "" {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	device, ok := state.Devices[body.DeviceID]
	if !ok || device.UserID != session.UserID {
		return nil, "not_found"
	}
	state.Devices[body.DeviceID] = device.Revoke(now)
	for id, candidate := range state.Sessions {
		if candidate.DeviceID == body.DeviceID {
			delete(state.Sessions, id)
		}
	}
	return map[string]bool{"revoked": true}, ""
}

func (runtime *connectRuntime) clearUser(state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	if !requireEmptyBody(request.Body) {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	next, err := domain.IncrementEpoch(state.UserEpochs[session.UserID])
	if err != nil {
		return nil, "temporary_unavailable"
	}
	state.UserEpochs[session.UserID] = next
	for id, device := range state.Devices {
		if device.UserID == session.UserID {
			state.Devices[id] = device.Revoke(now)
		}
	}
	for id, candidate := range state.Sessions {
		if candidate.UserID == session.UserID {
			delete(state.Sessions, id)
		}
	}
	return map[string]bool{"cleared": true}, ""
}

func (runtime *connectRuntime) clearAll(state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	if !requireEmptyBody(request.Body) {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	if !session.Admin {
		return nil, "forbidden"
	}
	next, err := domain.IncrementEpoch(state.GlobalEpoch)
	if err != nil {
		return nil, "temporary_unavailable"
	}
	state.GlobalEpoch = next
	for id, device := range state.Devices {
		state.Devices[id] = device.Revoke(now)
	}
	state.Sessions = map[string]sessionRecord{}
	return map[string]bool{"cleared": true}, ""
}

func (runtime *connectRuntime) listDevices(state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	if !requireEmptyBody(request.Body) {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	items := make([]map[string]any, 0)
	for _, device := range state.Devices {
		if device.UserID != session.UserID || device.RevokedAt != nil {
			continue
		}
		items = append(items, map[string]any{
			"device_id": device.ID, "device_name": device.DisplayName,
			"authorized_at": device.AuthorizedAt.Unix(), "last_seen_at": device.LastActivityAt.Unix(),
			"current": device.ID == session.DeviceID,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["authorized_at"].(int64) > items[j]["authorized_at"].(int64) })
	return map[string]any{"devices": items}, ""
}

func authenticateSession(state *providerState, request protocolv1.RequestMessage, now time.Time) (string, sessionRecord, string) {
	wantHash := hashString(request.Authorization.Credential)
	for id, session := range state.Sessions {
		matches := session.AccessHash == wantHash
		expiresAt := session.AccessExpiresAt
		if request.Authorization.Kind == "renewal" {
			matches = session.RenewalHash == wantHash
			expiresAt = session.RenewalExpiresAt
		}
		if !matches {
			continue
		}
		if request.SourceID != session.SourceID || request.DeviceID != session.DeviceID || request.DevicePublicKey != session.DevicePublicKey {
			return "", sessionRecord{}, "unauthorized"
		}
		device, ok := state.Devices[session.DeviceID]
		if !ok {
			return "", sessionRecord{}, "authorization_revoked"
		}
		current := domain.Epochs{Global: state.GlobalEpoch, User: state.UserEpochs[session.UserID]}
		binding := domain.SessionBinding{DeviceID: session.DeviceID, UserID: session.UserID, SourceID: session.SourceID, Epochs: session.Epochs, ExpiresAt: time.Unix(expiresAt, 0)}
		if !device.Accepts(binding, current, now) {
			return "", sessionRecord{}, "authorization_revoked"
		}
		if request.Authorization.Kind == "admin" && !session.Admin {
			return "", sessionRecord{}, "forbidden"
		}
		return id, session, ""
	}
	if request.Authorization.Kind == "renewal" {
		return "", sessionRecord{}, "reauthorization_required"
	}
	return "", sessionRecord{}, "unauthorized"
}

var _ = json.RawMessage{}
