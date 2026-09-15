package protocolv1

import (
	_ "embed"
	"encoding/json"
)

//go:embed operations.json
var rawContract []byte

type Contract struct {
	SchemaVersion       int               `json:"schema_version"`
	Status              string            `json:"status"`
	ProductID           string            `json:"product_id"`
	Packages            map[string]string `json:"packages"`
	PublicRouteMetadata []string          `json:"public_route_metadata"`
	SensitiveFields     []string          `json:"sensitive_fields"`
	Operations          []Operation       `json:"operations"`
	Errors              []string          `json:"errors"`
}

type Operation struct {
	ID                  string `json:"id"`
	Session             string `json:"session"`
	Idempotency         string `json:"idempotency"`
	ResponseSensitivity string `json:"response_sensitivity"`
}

func Load() (Contract, error) {
	var contract Contract
	err := json.Unmarshal(rawContract, &contract)
	return contract, err
}
