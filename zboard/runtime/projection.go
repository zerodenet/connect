package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	protocolv1 "github.com/zerodenet/connect/protocol/v1"
	pluginv1 "github.com/zerodenet/zboard/backend/pkg/pluginapi/v1"
)

const subscriptionFormat = "znet-sink"
const subscriptionReadCapability = "zboard.subscription.read.v1"
const accountSelfReadCapability = "zboard.account.self.read.v1"

func (runtime *connectRuntime) getAccount(ctx context.Context, state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	if !requireEmptyBody(request.Body) {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	host, err := runtime.openHost()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	defer host.Close()
	var account struct {
		Email string `json:"email"`
	}
	err = host.Call(ctx, accountSelfReadCapability, "account.self.get", map[string]any{
		"principal_id": session.UserID,
	}, &account)
	if err != nil {
		return nil, hostErrorCode(err)
	}
	if strings.TrimSpace(account.Email) == "" {
		return nil, "temporary_unavailable"
	}
	return map[string]any{"user_id": session.UserID, "email": account.Email}, ""
}

const maxSafeJSONInteger = int64(1<<53 - 1)

type subscriptionContentBody struct {
	SubscriptionID string         `json:"subscription_id"`
	KnownRevision  nullableString `json:"known_revision"`
}

type subscriptionUsageBody struct {
	SubscriptionID string `json:"subscription_id"`
}

type ownedSubscriptionUsage struct {
	ID        uint64    `json:"id"`
	FlowUsed  int64     `json:"flow_used"`
	FlowTotal int64     `json:"flow_total"`
	EndAt     time.Time `json:"end_at"`
}

type messageListBody struct {
	Cursor nullableString `json:"cursor"`
	Limit  int            `json:"limit"`
}

type messageIDBody struct {
	MessageID string `json:"message_id"`
}

func (runtime *connectRuntime) listSubscriptions(ctx context.Context, state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	if !requireEmptyBody(request.Body) {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	host, err := runtime.openHost()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	defer host.Close()
	var items []pluginv1.ProjectedSubscription
	err = host.Call(ctx, pluginv1.SubscriptionProjectionCapability, "subscriptions.list", pluginv1.SubscriptionListRequest{
		PrincipalID: session.UserID, Format: subscriptionFormat,
	}, &items)
	if err != nil {
		return nil, hostErrorCode(err)
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		result = append(result, subscriptionPayload(item, false))
	}
	return map[string]any{"subscriptions": result}, ""
}

func (runtime *connectRuntime) getSubscription(ctx context.Context, state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	var body subscriptionContentBody
	if decodeBody(request.Body, &body) != nil || strings.TrimSpace(body.SubscriptionID) == "" || !body.KnownRevision.Set {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	host, err := runtime.openHost()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	defer host.Close()
	known := ""
	if body.KnownRevision.Value != nil {
		known = *body.KnownRevision.Value
	}
	var item pluginv1.ProjectedSubscription
	err = host.Call(ctx, pluginv1.SubscriptionProjectionCapability, "subscriptions.get", pluginv1.SubscriptionContentRequest{
		PrincipalID: session.UserID, SubscriptionID: body.SubscriptionID, Format: subscriptionFormat, KnownRevision: known,
	}, &item)
	if err != nil {
		return nil, hostErrorCode(err)
	}
	return subscriptionPayload(item, true), ""
}

func (runtime *connectRuntime) getSubscriptionUsage(ctx context.Context, state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	var body subscriptionUsageBody
	if decodeBody(request.Body, &body) != nil {
		return nil, "invalid_request"
	}
	subscriptionID, parseErr := strconv.ParseUint(body.SubscriptionID, 10, 64)
	if parseErr != nil || subscriptionID == 0 || strconv.FormatUint(subscriptionID, 10) != body.SubscriptionID {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	host, err := runtime.openHost()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	defer host.Close()
	var usage ownedSubscriptionUsage
	err = host.Call(ctx, subscriptionReadCapability, "subscriptions.owned.get", map[string]any{
		"principal_id": session.UserID, "id": subscriptionID,
	}, &usage)
	if err != nil {
		code := hostErrorCode(err)
		if code == "forbidden" || code == "not_found" {
			return nil, "not_found"
		}
		return nil, code
	}
	expireAt := usage.EndAt.UnixMilli()
	if usage.ID != subscriptionID || usage.FlowUsed < 0 || usage.FlowUsed > maxSafeJSONInteger ||
		usage.FlowTotal <= 0 || usage.FlowTotal > maxSafeJSONInteger ||
		expireAt <= 0 || expireAt > maxSafeJSONInteger {
		return nil, "temporary_unavailable"
	}
	return map[string]any{
		"subscription_id":   body.SubscriptionID,
		"used_bytes":        usage.FlowUsed,
		"total_bytes":       usage.FlowTotal,
		"expire_at_unix_ms": expireAt,
	}, ""
}

func (runtime *connectRuntime) listMessages(ctx context.Context, state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	var body messageListBody
	if decodeBody(request.Body, &body) != nil || !body.Cursor.Set || body.Limit < 1 || body.Limit > 100 {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	host, err := runtime.openHost()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	defer host.Close()
	cursor := ""
	if body.Cursor.Value != nil {
		cursor = *body.Cursor.Value
	}
	var page pluginv1.MessagePage
	err = host.Call(ctx, pluginv1.MessageProjectionCapability, "messages.list", pluginv1.MessageListRequest{
		PrincipalID: session.UserID, Cursor: cursor, Limit: body.Limit,
	}, &page)
	if err != nil {
		return nil, hostErrorCode(err)
	}
	items := make([]map[string]any, 0, len(page.Items))
	for _, item := range page.Items {
		summary := map[string]any{
			"message_id": item.ID, "title": item.Title, "published_at": item.PublishedAt,
		}
		if item.ReadAt != 0 {
			summary["read_at"] = item.ReadAt
		} else {
			summary["read_at"] = nil
		}
		items = append(items, summary)
	}
	result := map[string]any{"messages": items, "next_cursor": nil}
	if page.NextCursor != "" {
		result["next_cursor"] = page.NextCursor
	}
	return result, ""
}

func (runtime *connectRuntime) getMessage(ctx context.Context, state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	var body messageIDBody
	if decodeBody(request.Body, &body) != nil || strings.TrimSpace(body.MessageID) == "" {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	host, err := runtime.openHost()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	defer host.Close()
	var item pluginv1.ProjectedMessage
	err = host.Call(ctx, pluginv1.MessageProjectionCapability, "messages.get", pluginv1.MessageGetRequest{
		PrincipalID: session.UserID, MessageID: body.MessageID,
	}, &item)
	if err != nil {
		return nil, hostErrorCode(err)
	}
	result := map[string]any{
		"message_id": item.ID, "title": item.Title, "body": item.Body, "published_at": item.PublishedAt,
		"read_at": nil,
	}
	if item.ReadAt != 0 {
		result["read_at"] = item.ReadAt
	}
	return result, ""
}

type nullableString struct {
	Set   bool
	Value *string
}

func (value *nullableString) UnmarshalJSON(raw []byte) error {
	value.Set = true
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		value.Value = nil
		return nil
	}
	var decoded string
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	value.Value = &decoded
	return nil
}

func subscriptionPayload(item pluginv1.ProjectedSubscription, includeContent bool) map[string]any {
	result := map[string]any{
		"subscription_id": item.ID, "display_name": item.DisplayName, "format": item.Format,
		"revision": item.Revision, "content_sha256": item.ContentSHA256, "updated_at": item.UpdatedAt,
	}
	if includeContent {
		if item.NotModified {
			result["not_modified"] = true
		} else {
			result["content"] = item.Content
		}
	}
	return result
}

func (runtime *connectRuntime) markMessageRead(ctx context.Context, state *providerState, request protocolv1.RequestMessage, now time.Time) (any, string) {
	var body messageIDBody
	if decodeBody(request.Body, &body) != nil || strings.TrimSpace(body.MessageID) == "" {
		return nil, "invalid_request"
	}
	_, session, code := authenticateSession(state, request, now)
	if code != "" {
		return nil, code
	}
	host, err := runtime.openHost()
	if err != nil {
		return nil, "temporary_unavailable"
	}
	defer host.Close()
	var item pluginv1.ProjectedMessage
	if err := host.Call(ctx, pluginv1.MessageProjectionCapability, "messages.get", pluginv1.MessageGetRequest{
		PrincipalID: session.UserID, MessageID: body.MessageID,
	}, &item); err != nil {
		return nil, hostErrorCode(err)
	}
	var result map[string]any
	err = host.Call(ctx, pluginv1.MessageProjectionCapability, "messages.mark-read", pluginv1.MessageMarkReadRequest{
		PrincipalID: session.UserID, MessageID: body.MessageID, Revision: item.Revision,
	}, &result)
	if err != nil {
		return nil, hostErrorCode(err)
	}
	return result, ""
}
