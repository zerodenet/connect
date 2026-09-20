package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	protocolv1 "github.com/zerodenet/connect/protocol/v1"
	pluginv1 "github.com/zerodenet/zboard/backend/pkg/pluginapi/v1"
)

func (runtime *connectRuntime) dispatch(ctx context.Context, state *providerState, request protocolv1.RequestMessage, now time.Time) (json.RawMessage, string) {
	var value any
	var code string
	switch request.Operation {
	case "authorization.password":
		value, code = runtime.authorizePassword(ctx, state, request, now)
	case "authorization.renew":
		value, code = runtime.renewAuthorization(state, request, now)
	case "authorization.revoke-device":
		value, code = runtime.revokeDevice(state, request, now)
	case "authorization.clear-user":
		value, code = runtime.clearUser(state, request, now)
	case "authorization.clear-all":
		value, code = runtime.clearAll(state, request, now)
	case "devices.list":
		value, code = runtime.listDevices(state, request, now)
	case "subscriptions.list":
		value, code = runtime.listSubscriptions(ctx, state, request, now)
	case "subscriptions.get-content":
		value, code = runtime.getSubscription(ctx, state, request, now)
	case "messages.list":
		value, code = runtime.listMessages(ctx, state, request, now)
	case "messages.get":
		value, code = runtime.getMessage(ctx, state, request, now)
	case "messages.mark-read":
		value, code = runtime.markMessageRead(ctx, state, request, now)
	default:
		return nil, "invalid_request"
	}
	if code != "" {
		return nil, code
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, "temporary_unavailable"
	}
	return raw, ""
}

func decodeBody(raw json.RawMessage, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return errors.New("invalid request body")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("invalid request body")
	}
	return nil
}

func requireEmptyBody(raw json.RawMessage) bool {
	var object map[string]json.RawMessage
	return decodeBody(raw, &object) == nil && len(object) == 0
}

func hostErrorCode(err error) string {
	var callErr *pluginv1.HostCallError
	if errors.As(err, &callErr) {
		switch callErr.Code {
		case "invalid_request", "invalid_credentials", "unauthorized", "forbidden", "not_found", "conflict", "rate_limited", "temporary_unavailable":
			return callErr.Code
		}
	}
	return "temporary_unavailable"
}
