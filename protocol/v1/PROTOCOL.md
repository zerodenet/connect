# ZeroDenet Connect protocol v1

This document is the normative P0 wire contract between a Connect provider adapter and a Connect
client adapter. Host APIs, host navigation, database schemas, and proxy-kernel configuration are
outside this contract.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are interpreted as described by
RFC 2119 and RFC 8174.

## Transport and routes

Providers expose exactly these protocol routes below their configured HTTPS origin:

- `GET /.well-known/zerodenet-connect/v1/capabilities`
- `POST /.well-known/zerodenet-connect/v1/exchange`

TLS certificate and hostname validation is mandatory. Credentials, tokens, encrypted envelopes,
and business identifiers MUST NOT appear in URLs, redirects, access-log metadata, or discovery
responses. The exchange request and response use `application/json`. Decrypted request or response
messages above 5 MiB are rejected, and the outer envelope size is bounded before HPKE authentication.

Discovery is public and returns `protocol_version`, `provider_id`, `identity_key_id`,
`identity_public_key`, `identity_fingerprint`, `provider_key_statement`, and the supported operation
IDs. `provider_id` is the canonical HTTPS origin, without a path, query, fragment, or user info.

## Algorithms and binary encoding

Protocol v1 has one mandatory HPKE suite from RFC 9180:

- KEM `DHKEM(X25519, HKDF-SHA256)` (`0x0020`)
- KDF `HKDF-SHA256` (`0x0001`)
- AEAD `ChaCha20Poly1305` (`0x0003`)
- suite label `HPKE-0x0020-0x0001-0x0003`

All binary JSON values use unpadded base64url. Decoders reject non-canonical base64url, duplicate or
unknown schema fields, unsupported versions or suites, and out-of-range values.

Go uses Cloudflare CIRCL v1.6.3. The independent reference consumer uses `hpke` v0.14.1 for Rust.
`testdata/vectors.json` is a deterministic base-mode request and authenticated-mode response known
answer test shared by both implementations.

## Provider trust and key rotation

The provider has a long-lived Ed25519 identity key and one or more short-lived X25519 HPKE keys.
On first connection the client MUST require the user to confirm the Ed25519 fingerprint through an
independent trusted channel or an explicitly identified trust-on-first-use action. A valid web PKI
connection does not silently authorize a new Connect identity.

An HPKE key is accepted only with a `ProviderKeyStatement` signed by the pinned identity key. Its
signature input is the following fields, each prefixed by an unsigned four-byte big-endian length:

1. `zerodenet-connect/v1/provider-key`
2. `provider_id`
3. `identity_key_id`
4. `key_id`
5. `hpke_public_key` as its base64url text
6. `not_before` as an eight-byte unsigned big-endian Unix timestamp
7. `not_after` in the same encoding

An HPKE statement lasts at most 90 days. Clients allow at most 30 seconds of clock skew and retain a
previous valid key while requests using it can still be replayed or recovered.

Identity rotation requires one statement signed by both old and new Ed25519 keys. The length-prefixed
fields are `zerodenet-connect/v1/identity-rotation`, `provider_id`, `old_identity_key_id`,
`new_identity_key_id`, `new_public_key` as base64url text, and `not_before` as an eight-byte timestamp.
An unlinked identity replacement is a trust mismatch and requires explicit user approval.

## Encrypted exchange

The outer request and response envelope has exactly these fields:

```json
{
  "protocol_version": 1,
  "suite": "HPKE-0x0020-0x0001-0x0003",
  "key_id": "provider-2026-09",
  "request_id": "MDEyMzQ1Njc4OWFiY2RlZg",
  "encapsulation": "base64url",
  "ciphertext": "base64url"
}
```

`request_id` is exactly 16 random bytes encoded as base64url. `key_id` selects a currently valid,
identity-signed provider HPKE key.

Requests use HPKE Base mode to the provider key. The HPKE `info` is
`zerodenet-connect/v1/request/{key_id}` and AAD is the byte concatenation
`zerodenet-connect/v1/request`, NUL, `key_id`, NUL, `request_id`.

Every request contains a fresh X25519 `response_public_key`; its private key is held only until the
matching response is processed. Responses use HPKE Auth mode to that response key, with the provider
HPKE key as the authenticated sender key. Response `info` is
`zerodenet-connect/v1/response/{key_id}` and AAD uses `zerodenet-connect/v1/response`, NUL,
`key_id`, NUL, `request_id`. This prevents a TLS terminator or another provider key from forging a
successful business response.

## Inner request and device proof

After decryption the provider accepts this strict JSON object:

```json
{
  "protocol_version": 1,
  "operation": "subscriptions.get-content",
  "request_id": "MDEyMzQ1Njc4OWFiY2RlZg",
  "issued_at": 1800000000,
  "expires_at": 1800000090,
  "source_id": "source-local-1",
  "device_id": "device-local-1",
  "device_public_key": "base64url-ed25519-key",
  "response_public_key": "base64url-x25519-key",
  "authorization": {"kind": "access", "credential": "opaque-secret"},
  "body": {},
  "device_proof": "base64url-ed25519-signature"
}
```

The inner and outer request IDs MUST match. Requests live for at most 120 seconds and allow 30
seconds of clock skew. `source_id` is a host-generated stable identifier for one configured source;
`device_id` is a host-generated stable identifier for one installation. Both are opaque identifiers
of 1 to 128 ASCII letters, digits, dot, underscore, or hyphen.

Every encrypted request is signed by the device Ed25519 key. For `authorization.password`, the key
is registered only after credential validation. Later operations MUST match the key bound to the
device session. The proof input contains these fields in order, each prefixed by an unsigned
four-byte big-endian length:

1. `zerodenet-connect/v1/device-proof`
2. `operation`
3. `request_id`
4. `issued_at` as eight-byte unsigned big-endian
5. `expires_at` in the same encoding
6. `source_id`
7. `device_id`
8. `device_public_key` as base64url text
9. `response_public_key` as base64url text
10. authorization `kind`
11. SHA-256 of the UTF-8 authorization credential
12. SHA-256 of the exact received JSON bytes of `body`

This transcript avoids a dependency on a JSON canonicalization convention. Implementations MUST
preserve the exact `body` bytes for proof verification.

Authorization kinds are fixed: `password` for `authorization.password`, `renewal` for
`authorization.renew`, `admin` for `authorization.clear-all`, and `access` for every other encrypted
operation. `capabilities.get` is discovery-only and is never sent through exchange.

## Inner response

The authenticated response contains `protocol_version`, `operation`, `request_id`, `issued_at`,
`expires_at`, and `status`. An `ok` response has a non-null JSON `body` and no `error`. An `error`
response has no body and has `error.code` from `operations.json`; `retry_after` is an optional Unix
timestamp. Operation and request IDs MUST match the request. The response validity window is at most
120 seconds.

Failures before the request can be authenticated return a generic HTTP error without business
details. Once the response key and proof are authenticated, business errors use an encrypted Auth
mode response.

## Replay and renewal recovery

The provider atomically reserves `(key_id, request_id)` before running an operation and stores a
SHA-256 hash of the complete outer request:

- A byte-identical retry receives the cached encrypted response.
- Reuse of the same tuple with a different outer request is `replay_rejected` and does not execute.
- The reservation and cached response are retained until at least five minutes after `expires_at`.

Access credentials are opaque, contain at least 256 random bits, expire within 15 minutes, and are
bound to provider, user, `source_id`, `device_id`, and device public key. Renewal credentials meet the
same entropy and binding requirements and expire within 30 days. Providers store only a
cryptographic digest of either credential.

Renewal credentials rotate on every successful `authorization.renew`. A byte-identical retry with
the original request ID returns the cached new credential pair. Reuse with another request ID is
`reauthorization_required`; it MUST NOT create another session. Revocation immediately invalidates
both credential classes for the selected device.

## P0 operation payloads

Payloads are JSON objects. Providers may add fields only in a later protocol version.

- `authorization.password`: body `{ "account": string, "device_name": string }`; the password is
  the authorization credential. Returns `user_id`, `device_id`, `access_credential`,
  `access_expires_at`, `renewal_credential`, and `renewal_expires_at`.
- `authorization.renew`: empty body. Returns a rotated access/renewal pair and expirations.
- `authorization.revoke-device`: body `{ "device_id": string }`; returns `{ "revoked": true }`.
- `authorization.clear-user`: empty body; returns `{ "cleared": true }` for the current user.
- `authorization.clear-all`: empty body; returns `{ "cleared": true }` for the provider.
- `devices.list`: empty body. Returns devices visible to the current user, with `device_id`,
  `device_name`, `authorized_at`, `last_seen_at`, and `current`.
- `subscriptions.list`: empty body. Returns `subscription_id`, `display_name`, `format`, `revision`,
  `content_sha256`, and `updated_at` for each entitled subscription.
- `subscriptions.get-content`: body `{ "subscription_id": string, "known_revision": string|null }`.
  Returns the same metadata plus `content` when changed, or `{ "not_modified": true, ...metadata }`.
- `messages.list`: body `{ "cursor": string|null, "limit": integer }`. Returns message summaries
  and an optional `next_cursor`.
- `messages.get`: body `{ "message_id": string }`. Returns `message_id`, `title`, `body`,
  `published_at`, and `read_at`.
- `messages.mark-read`: body `{ "message_id": string }`; returns `message_id` and `read_at`.

Subscription delivery is namespaced by `(source_id, provider_id, subscription_id)`. A client MUST
NOT overwrite a configuration-file subscription or another source merely because its display name
matches. The UI label is presentation metadata; the recommended label is
`{source display name} · {subscription display_name}`. Revision and content hash determine updates.

## Secret handling

Adapters MUST use host-provided secret storage, networking, scheduling, subscription delivery, and
notification capabilities. Passwords are request-local and MUST NOT be persisted. Private identity,
HPKE, device, access, and renewal material MUST NOT enter logs, diagnostics, plugin configuration,
URLs, or host navigation state. Client adapters do not write active proxy configuration directly;
they deliver managed subscriptions through the client host.
