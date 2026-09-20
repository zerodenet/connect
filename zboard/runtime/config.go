package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strings"
)

type runtimeConfig struct {
	Enabled     bool   `json:"enabled"`
	ProviderID  string `json:"provider_id"`
	DisplayName string `json:"display_name"`
}

func normalizeConfig(raw []byte) (runtimeConfig, []byte, error) {
	config := runtimeConfig{DisplayName: "ZBoard"}
	if len(bytes.TrimSpace(raw)) != 0 {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&config); err != nil {
			return runtimeConfig{}, nil, errors.New("invalid Connect configuration")
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			return runtimeConfig{}, nil, errors.New("invalid Connect configuration")
		}
	}
	config.ProviderID = strings.TrimSpace(config.ProviderID)
	config.DisplayName = strings.TrimSpace(config.DisplayName)
	if config.DisplayName == "" {
		config.DisplayName = "ZBoard"
	}
	if len(config.DisplayName) > 80 {
		return runtimeConfig{}, nil, errors.New("display_name is too long")
	}
	if config.ProviderID != "" && !validProviderOrigin(config.ProviderID) {
		return runtimeConfig{}, nil, errors.New("provider_id must be an HTTPS origin without a path")
	}
	if config.Enabled && config.ProviderID == "" {
		return runtimeConfig{}, nil, errors.New("provider_id is required when Connect is enabled")
	}
	normalized, err := json.Marshal(config)
	return config, normalized, err
}

func validProviderOrigin(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil &&
		parsed.Path == "" && parsed.RawPath == "" && parsed.RawQuery == "" && parsed.Fragment == ""
}
