# Delivery status

## P0 contract and host inventory

- [x] Independent Git repository and host-neutral protocol/reference-adapter layout.
- [x] Stable draft identities aligned across protocol, package, and marketplace templates.
- [x] Shared operation/error/sensitivity inventory.
- [x] Server authorization-generation and device-record invariants with tests.
- [x] Client source-binding identity and late-result commit guards with tests.
- [x] Current host capability gap inventory.
- [x] Release packaging and independent signed-artifact verification.
- [x] Signed ZNet Sink management page with source configuration, transient login entry, stage status, diagnostics, and bounded `host_start` action.
- [x] Separate signed ZBoard account-device and administrator-communication pages using the existing page/config bridge.
- [x] Author-side ZNet Sink packager support for signed management-page payloads, with package-content tests.
- [x] Frozen v1 cryptographic suite, message transcript, provider identity statements and Go/Rust byte-level vectors.
- [x] Connect-side drafts and tests for the generic ZBoard contracts it would consume.
- [x] Connect provider runtime draft with password authorization, device-bound credential rotation/revocation, replay recovery and projection tests.
- [x] Connect-side drafts and tests for configured-origin networking, encrypted credential vault, device crypto and managed-subscription application.
- [x] Signed client management page performs provider verification, device authorization, renewal, subscription selection/application, revision-aware manual refresh, and read-only message viewing without polling.
- [x] Platform-specific ZBoard runtime packaging inputs and runtime-version injection cover Linux, macOS, and Windows without exceeding the host's per-package size boundary.
- [x] Generic scheduled component execution can reuse the typed host SDK with the guest CPU/output boundary, late authorization checks, and durable bounded retry state.
- [x] Connect declares a 15-minute task and performs page-independent renewal, revision-aware managed-subscription refresh, message synchronization, unread notification deduplication, and explicit revocation cleanup in local contract tests.
- [x] Multiple client sources are represented as isolated source instances with separate trust, device key, credentials, binding, message cursor, and scheduled task; source removal uses an owner-checked host operation to remove only that plugin's managed subscription.
- [x] Background notifications carry a host-validated signed-page route and source-specific reference; the destination rechecks the active source/account before loading message content.
- [x] Frozen clean-host capability audit; prior modified-host acceptance invalidated.
- [x] Plugin-owned capability status separated from clean-host availability.
- [x] Required public host capabilities independently available in committed ZNet Sink and ZBoard baselines.
- [x] Installed-host cross-product end-to-end acceptance on clean, unmodified host worktrees.

## Later phases

P0 is accepted for development publication. The accepted scope is the signed package lifecycle,
device authorization, subscription projection/application, message synchronization, and scheduled
refresh on the two committed host baselines recorded in `zboard/release-readiness.json`. Production
deployment and broader provider/client interoperability remain later-phase work; a dev release is
not a stable production claim.
