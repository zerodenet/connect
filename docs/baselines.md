# Evidence baseline

Captured on 2026-09-15 before this repository was initialized.

| Surface | Working baseline | Evidence used here |
| --- | --- | --- |
| Product plan | `/Volumes/tool/rust/gui/docs/gui/zboard-plugin-implementation-plan.md` | v0.0.1 scope, ownership, phases, and one-product/two-target repository shape |
| Marketplace | `codex/unified-marketplace` at `07ccd9600951814b8de7d2f2ef942b93c54def4d`, with uncommitted implementation | registry schema 3, release manifest schema 1, fixed host/channel static JSON API, local compatibility selection |
| ZBoard consumer | `codex/unified-marketplace` at `3bf048ff467644a0c2d667305560b871de986114`, with uncommitted consumer changes | `.zbplugin` identity and artifact selection; current public plugin capabilities |
| ZNet Sink consumer | `codex/unified-marketplace` at `8d9c99ed1b2b7dd3dfb4eb44b2e31670009b7266`, with uncommitted consumer changes | `.zspkg` identity and artifact selection; current JS manifest and network capability |
| Marketplace implementation task | `codex://threads/01a0a322-1bf2-7762-89fc-596bfa009ae5` | current static Pages API and dual-host product/release behavior |

A SHA names the committed base only; the marketplace and both consumer implementations above had
uncommitted changes. Re-read their final committed contracts before the first package build.

The source plan used ZBoard and ZNet Sink as the first delivery example. This repository
generalizes that example into provider and consumer protocol roles; the two named products remain
reference adapters and acceptance environments, not protocol identity.

## Clean-host release gate (2026-09-20)

The current acceptance baseline is deliberately stricter than the historical planning evidence:

| Host | Clean committed baseline | Result with the current Connect package |
| --- | --- | --- |
| ZNet Sink | `8e1972cbfe15579dee631caa607f0a2c4d1fff25` | signed package import and managed-provider flow passed |
| ZBoard | `7182680aa9d2bb3bd9f85ecc51c42051d2d1d619` (`v0.0.2-rc.202609201141`) | signed package import, dynamic route lifecycle and provider runtime passed |

Neither baseline may be replaced by a dirty host worktree when recording release readiness. The
same packages also passed the cross-host authorization, subscription and message flow. The detailed
capability mapping is in [clean-host-capability-audit.md](clean-host-capability-audit.md).
