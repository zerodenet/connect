# Protocol v1 work area

`PROTOCOL.md` is the frozen P0 wire contract. `operations.json` is its machine-readable operation,
authorization, sensitivity, and public-error inventory. The protocol uses RFC 9180 HPKE with
X25519/HKDF-SHA256/ChaCha20-Poly1305, Ed25519 device and provider identity proofs, bounded replay
windows, and rotating renewal credentials.

`testdata/vectors.json` is produced by the Go implementation using Cloudflare CIRCL v1.6.3. The
independent Rust crate under `reference/rust` opens the base-mode request and authenticated-mode
response with `hpke` v0.14.1. `make test` runs both implementations and negative Go tests.

Conformance is role-based. A provider implementation must pass provider vectors and
authorization/entitlement tests; a consumer implementation must pass trust binding, replay,
renewal recovery, source-binding, and late-result tests. Product names, public panel APIs, client
IPC, and kernel configuration formats are outside the shared contract.
