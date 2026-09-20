package protocolv1

import "testing"

func TestContractInventoryIsCompleteAndUnique(t *testing.T) {
	contract, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if contract.SchemaVersion != 1 || contract.Status != "p0-wire-v1-frozen" {
		t.Fatalf("unexpected contract header: %#v", contract)
	}
	if contract.ProductID != "org.zerodenet.connect" {
		t.Fatalf("unexpected product id: %q", contract.ProductID)
	}
	if contract.Packages["zboard"] != "org.zerodenet.connect.zboard" || contract.Packages["znet-sink"] != "org.zerodenet.connect.znet-sink" {
		t.Fatalf("unexpected package identities: %#v", contract.Packages)
	}
	seen := map[string]bool{}
	for _, operation := range contract.Operations {
		if operation.ID == "" || operation.Session == "" || operation.Idempotency == "" || operation.ResponseSensitivity == "" {
			t.Fatalf("incomplete operation: %#v", operation)
		}
		if seen[operation.ID] {
			t.Fatalf("duplicate operation: %s", operation.ID)
		}
		seen[operation.ID] = true
	}
	for _, required := range []string{"authorization.password", "authorization.renew", "authorization.clear-user", "subscriptions.get-content", "messages.get"} {
		if !seen[required] {
			t.Fatalf("required operation is missing: %s", required)
		}
	}
}
