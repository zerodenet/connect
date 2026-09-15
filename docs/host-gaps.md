# P0 reference-adapter host capability gaps

Packaging is blocked until these are resolved as generic host capabilities. The names below are
responsibilities, not reserved API identifiers.

## ZBoard

Current code exposes page, configuration, encrypted private storage, and identity-provider
capabilities. The initial ZBoard provider adapter additionally needs:

- declarative, host-governed plugin HTTP routes with lifecycle shutdown and request limits;
- password verification that returns only a user assertion, never hashes or a general host token;
- current entitled-subscription listing and rendering for one asserted user;
- current announcement/private-message listing and detail projection with audience checks;
- authenticated account/admin page context and trusted client-IP projection;
- atomic plugin storage operations adequate for global/user revocation epochs and multi-instance
  compare-and-swap behavior;
- server secret generation/storage suitable for the plugin communication private key.

## ZNet Sink

Current code exposes a bounded JavaScript VM and controlled `network.request`, but its manifest
uses a statically declared origin. The initial ZNet Sink client adapter additionally needs:

- user-approved dynamic origin bindings for configured compatible providers;
- secret input and opaque secret/device-key handles that survive restart without exposing values;
- maintained cryptographic operations suitable for the frozen wire protocol;
- declared plugin pages/forms and safe internal route navigation;
- background task registration through the existing scheduler, including cancellation and
  generation/authorization checks;
- a source-provider binding that can create or reuse a managed subscription and call the single
  existing synchronization path;
- notifications with source identity, deduplication state, and safe plugin-detail targets.

The first host changes should be narrow capability contracts with negative tests. They must not
add provider-brand branches to generic runtime, encode a kernel in the shared protocol, or create
a second configuration/scheduler backend.
