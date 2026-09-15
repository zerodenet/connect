# Protocol v1 work area

`operations.json` is the shared P0 inventory for provider and consumer implementations. It fixes
product/package identity, operation names, authorization requirements, sensitivity, and stable
public error codes so implementations can be tested against the same source without inheriting a
panel or kernel API.

It is not yet the wire protocol. In particular it does not select HPKE/Noise/TLS exporter usage,
AEAD/KDF suites, encodings, nonce construction, replay-window size, session/renewal token format,
or key-rotation proof. Those choices require maintained Go and client-runtime libraries plus
cross-language positive and negative vectors before this directory can be marked frozen.

Conformance will be role-based. A provider implementation must pass provider vectors and
authorization/entitlement tests; a consumer implementation must pass trust binding, replay,
renewal recovery, source-binding, and late-result tests. Product names, public panel APIs, client
IPC, and kernel configuration formats are outside the shared contract.
