# Protocol v1 work area

`operations.json` is the shared P0 inventory for both packages. It fixes product/package identity,
operation names, authorization requirements, sensitivity, and stable public error codes so the
two implementations can be tested against the same source.

It is not yet the wire protocol. In particular it does not select HPKE/Noise/TLS exporter usage,
AEAD/KDF suites, encodings, nonce construction, replay-window size, session/renewal token format,
or key-rotation proof. Those choices require maintained Go and client-runtime libraries plus
cross-language positive and negative vectors before this directory can be marked frozen.
