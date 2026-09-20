package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	pluginv1 "github.com/zerodenet/zboard/backend/pkg/pluginapi/v1"
)

func (runtime *connectRuntime) HandlePageAction(ctx context.Context, request *pluginv1.PageActionRequest) (*pluginv1.PageActionResponse, error) {
	if request.GetPageId() != "authorized-devices" || request.GetSurface() != "account" || request.GetActorId() == "" {
		return pageActionResult(map[string]string{"error": "forbidden"})
	}
	config := runtime.currentConfig()
	if !config.Enabled {
		return pageActionResult(map[string]string{"error": "communication_disabled"})
	}
	runtime.opMu.Lock()
	defer runtime.opMu.Unlock()
	storage, err := runtime.openStorage()
	if err != nil {
		return nil, err
	}
	defer storage.Close()
	loaded, err := loadProviderState(ctx, storage, config.ProviderID, time.Now().UTC())
	if err != nil {
		return nil, err
	}

	switch request.GetAction() {
	case "devices.list":
		items := make([]map[string]any, 0)
		for _, device := range loaded.value.Devices {
			if device.UserID != request.GetActorId() {
				continue
			}
			item := map[string]any{
				"device_id": device.ID, "device_name": device.DisplayName, "source_id": device.SourceID,
				"authorized_at": device.AuthorizedAt.Unix(), "last_seen_at": device.LastActivityAt.Unix(),
				"revoked": device.RevokedAt != nil,
			}
			items = append(items, item)
		}
		sort.Slice(items, func(i, j int) bool { return items[i]["authorized_at"].(int64) > items[j]["authorized_at"].(int64) })
		return pageActionResult(map[string]any{"devices": items})
	case "devices.revoke":
		var payload struct {
			DeviceID string `json:"device_id"`
		}
		if decodeBody(request.GetPayloadJson(), &payload) != nil || strings.TrimSpace(payload.DeviceID) == "" {
			return pageActionResult(map[string]string{"error": "invalid_request"})
		}
		device, ok := loaded.value.Devices[payload.DeviceID]
		if !ok || device.UserID != request.GetActorId() {
			return pageActionResult(map[string]string{"error": "not_found"})
		}
		loaded.value.Devices[payload.DeviceID] = device.Revoke(time.Now().UTC())
		for id, session := range loaded.value.Sessions {
			if session.DeviceID == payload.DeviceID {
				delete(loaded.value.Sessions, id)
			}
		}
		if err := loaded.save(ctx, storage); err != nil {
			return nil, err
		}
		return pageActionResult(map[string]any{"revoked": true, "device_id": payload.DeviceID})
	default:
		return pageActionResult(map[string]string{"error": "not_found"})
	}
}

func pageActionResult(value any) (*pluginv1.PageActionResponse, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return &pluginv1.PageActionResponse{ResultJson: raw}, nil
}
