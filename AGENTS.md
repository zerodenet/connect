# Repository guidelines

This repository produces the host-neutral Connect protocol and independently signed host adapters.
The first marketplace product contains `org.zerodenet.connect.zboard` for ZBoard and
`org.zerodenet.connect.znet-sink` for ZNet Sink.
Keep shared wire semantics under `protocol/`, ZBoard code under `zboard/`, ZNet Sink code under
`znet-sink/`, and cross-host fixtures under `tests/interop/`.

The v0.0.1 product boundary is a compatible provider source, device authorization, session renewal,
subscription delivery through the client's existing subscription pipeline, and read-only
message notifications. It is not a second ZBoard panel. Do not add purchasing, account
management, device management in the client, direct Zero IPC, or a second configuration path.

Host-owned capabilities remain host-owned. A provider adapter must use narrow panel Host APIs,
never the core database, password hashes, administrator tokens, or public login/subscription
HTTP APIs. A client adapter must use its host's network, secret, scheduler, source-provider,
subscription-delivery, notification, and internal-navigation capabilities; it must not open
sockets, persist passwords, or write active configuration directly. Neither the shared protocol
nor provider adapters may name or control a proxy kernel; kernel selection remains a client-host
implementation detail.

The application-layer protocol is not frozen until P0 chooses maintained cryptographic
libraries and publishes cross-language test vectors. Do not invent cryptographic primitives,
reuse nonces, put credentials in URLs, or describe TLS as a replacement for the encrypted
business envelope.

Run `make check` before committing. Package and release targets must refuse placeholder keys,
commits, host versions, or missing host capabilities. Never commit signing keys or generated
packages. Report code, commit, push, publication, installation, and end-to-end acceptance as
separate states.
