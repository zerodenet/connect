# Architecture boundary

The business and transport directions are fixed:

```text
ZNet Sink plugin -> managed subscription source -> existing subscription sync -> configuration
ZNet Sink plugin -> controlled host network -> ZBoard plugin route -> narrow ZBoard Host APIs
```

The ZNet Sink package owns source configuration, trusted server-key binding, authorization flow,
subscription selection, remote-state checks, and read-only message presentation. ZNet Sink owns
network and secret handles, scheduling, source bindings, synchronization, notification delivery,
navigation, cancellation, deduplication, and late-result rejection.

The ZBoard package owns its declared protocol route, encrypted requests and responses, device
records, renewal credentials, revocation epochs, subscription/message orchestration, and embedded
account/admin pages. ZBoard remains authoritative for password verification, identity, current
entitlements, subscription rendering, message audience, administrator roles, and the real client
IP derived from its trusted proxy configuration.

The plugin never calls ZBoard's public login or subscription APIs, receives a core database
handle, or writes core business tables. It never bypasses ZNet Sink's subscription model to write
a running Zero configuration. Zero executes the selected network path and configuration; it has
no ZBoard-specific protocol or session knowledge.

The wire contract in `protocol/v1/operations.json` is an operation/error inventory. P0 must still
freeze the byte-level envelope, maintained cryptographic libraries, bidirectional keys/nonces,
replay window, retry semantics, rotation, size limits, and cross-language vectors before any
network handler is considered implemented.
