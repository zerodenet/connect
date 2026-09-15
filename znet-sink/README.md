# ZNet Sink package

`src/binding.mjs` implements host-independent source-binding and late-result checks that can be
moved behind the eventual ZNet Sink SDK. The package manifest is intentionally a template:
today's host requires a static network origin and does not expose the secret, scheduler,
source-provider, subscription-delivery, notification, or plugin-page capabilities required by
v0.0.1. Provider-specific behavior belongs behind the shared protocol and source binding, not in
the client host or its kernel adapter.

Do not package the example origin or zero source digest. Once host contracts land, generate one
component manifest per isolated role, hash the exact source bytes, and test it with the host's
real pack/verify tooling.
