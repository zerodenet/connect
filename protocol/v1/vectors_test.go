package protocolv1

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type conformanceVectors struct {
	SchemaVersion  int           `json:"schema_version"`
	Suite          string        `json:"suite"`
	KeyID          string        `json:"key_id"`
	RequestID      string        `json:"request_id"`
	Provider       vectorKeyPair `json:"provider"`
	ClientResponse vectorKeyPair `json:"client_response"`
	Request        vectorMessage `json:"request"`
	Response       vectorMessage `json:"response"`
}

type vectorKeyPair struct {
	KeySeed    string `json:"key_seed"`
	PublicKey  string `json:"public_key"`
	PrivateKey string `json:"private_key"`
}

type vectorMessage struct {
	Mode              string          `json:"mode"`
	EncapsulationSeed string          `json:"encapsulation_seed"`
	Info              string          `json:"info"`
	AAD               string          `json:"aad"`
	Plaintext         string          `json:"plaintext"`
	Envelope          json.RawMessage `json:"envelope"`
}

func TestGoConformsToFixedHPKEVectors(t *testing.T) {
	vectors := loadVectors(t)
	providerPublic := vectorBytes(t, vectors.Provider.PublicKey)
	providerPrivate := vectorBytes(t, vectors.Provider.PrivateKey)
	clientPublic := vectorBytes(t, vectors.ClientResponse.PublicKey)
	clientPrivate := vectorBytes(t, vectors.ClientResponse.PrivateKey)
	requestPlaintext := vectorBytes(t, vectors.Request.Plaintext)
	responsePlaintext := vectorBytes(t, vectors.Response.Plaintext)

	var requestEnvelope RequestEnvelope
	if err := json.Unmarshal(vectors.Request.Envelope, &requestEnvelope); err != nil {
		t.Fatal(err)
	}
	openedRequest, err := OpenRequest(providerPrivate, requestEnvelope)
	if err != nil || !bytes.Equal(openedRequest, requestPlaintext) {
		t.Fatalf("open request: plaintext=%q err=%v", openedRequest, err)
	}
	generatedRequest, err := sealRequest(providerPublic, vectors.KeyID, vectors.RequestID, requestPlaintext, bytes.NewReader(vectorBytes(t, vectors.Request.EncapsulationSeed)))
	if err != nil || !reflect.DeepEqual(generatedRequest, requestEnvelope) {
		t.Fatalf("request vector drift: generated=%#v expected=%#v err=%v", generatedRequest, requestEnvelope, err)
	}

	var responseEnvelope ResponseEnvelope
	if err := json.Unmarshal(vectors.Response.Envelope, &responseEnvelope); err != nil {
		t.Fatal(err)
	}
	openedResponse, err := OpenResponse(clientPrivate, providerPublic, responseEnvelope)
	if err != nil || !bytes.Equal(openedResponse, responsePlaintext) {
		t.Fatalf("open response: plaintext=%q err=%v", openedResponse, err)
	}
	generatedResponse, err := sealResponse(providerPrivate, clientPublic, vectors.KeyID, vectors.RequestID, responsePlaintext, bytes.NewReader(vectorBytes(t, vectors.Response.EncapsulationSeed)))
	if err != nil || !reflect.DeepEqual(generatedResponse, responseEnvelope) {
		t.Fatalf("response vector drift: generated=%#v expected=%#v err=%v", generatedResponse, responseEnvelope, err)
	}

	if got := encodeBinary(requestInfo(vectors.KeyID)); got != vectors.Request.Info {
		t.Fatalf("request info drift: %s", got)
	}
	if got := encodeBinary(requestAAD(vectors.KeyID, vectors.RequestID)); got != vectors.Request.AAD {
		t.Fatalf("request AAD drift: %s", got)
	}
	if got := encodeBinary(responseInfo(vectors.KeyID)); got != vectors.Response.Info {
		t.Fatalf("response info drift: %s", got)
	}
	if got := encodeBinary(responseAAD(vectors.KeyID, vectors.RequestID)); got != vectors.Response.AAD {
		t.Fatalf("response AAD drift: %s", got)
	}
}

func loadVectors(t *testing.T) conformanceVectors {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors conformanceVectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.SchemaVersion != 1 || vectors.Suite != SuiteID {
		t.Fatalf("unexpected vector header: %#v", vectors)
	}
	return vectors
}

func vectorBytes(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := decodeBinary(value, 1, MaxPlaintext)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}
