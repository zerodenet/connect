# Architecture boundary

Provider Bridge has two interoperable roles and host-specific adapters:

```text
provider implementation -> Provider Bridge protocol -> client adapter
client adapter -> managed source -> existing subscription sync -> client configuration -> selected kernel
```

A provider implementation owns its declared protocol route, encrypted requests and responses,
device records, renewal credentials, revocation epochs, subscription/message orchestration, and
its own management surface. The provider host remains authoritative for password verification,
identity, current entitlements, subscription rendering, message audience, administrator roles,
and the real client IP derived from trusted proxy configuration.

A client adapter owns source configuration, trusted provider-key binding, authorization flow,
subscription selection, remote-state checks, and read-only message presentation. The client host
owns network and secret handles, scheduling, source bindings, synchronization, notification
delivery, navigation, cancellation, deduplication, late-result rejection, configuration assembly,
and kernel lifecycle.

The initial `zboard/` and `znet-sink/` directories are reference adapters, not protocol ownership.
A compatible XBoard-like provider may implement the provider contract directly or through its own
adapter. Another client may implement the consumer contract and use a different kernel without
changing the wire protocol. The protocol therefore contains no ZBoard database/API dialect,
ZNet Sink IPC, or Zero configuration commands.

Adapters never call a panel's public login/subscription API as an internal shortcut, receive core
database handles, or write core business tables. Client adapters never bypass the host's managed
source and subscription model to write a running kernel configuration.

The wire contract in `protocol/v1/operations.json` is an operation/error inventory. P0 must still
freeze the byte-level envelope, maintained cryptographic libraries, bidirectional keys/nonces,
replay window, retry semantics, rotation, size limits, and cross-language vectors before any
network handler is considered implemented.
