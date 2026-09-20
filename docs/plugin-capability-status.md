# Connect plugin capability status

This status separates code owned by Connect from capabilities owned by an installation host. The
accepted baseline uses committed host implementations; no Connect acceptance modifies host source.

| Capability | Connect-owned implementation | Clean-host status | Delivery status |
| --- | --- | --- | --- |
| Protocol discovery, signed provider identity, transcript and wire format | implemented with Go/Rust byte vectors and interop tests | exact manifest routes are governed by ZBoard | accepted |
| Device authorization, renewal, revocation and replay handling | implemented in the provider runtime/domain with local tests | bounded account assertion plus persistent client vault/device crypto | accepted |
| Entitled subscription list/content projection | implemented through the public ZBoard host SDK | subscription projection available | accepted |
| Stable client subscription binding and late-result guards | implemented and tested; identity is plugin/provider/remote-subscription scoped | managed-subscription API available | accepted |
| Provider messages and unread notification deduplication | implemented for explicit refresh and scheduled sync | read-only message projection available | accepted |
| Progressive client management UI | implemented; no polling loop, direct browser network call, or persisted password | signed page uses typed host capabilities | accepted |
| ZBoard account/admin pages | implemented as declared plugin pages using the page bridge | lifecycle and actor context are host governed | accepted |
| Scheduled renewal/synchronization | implemented through typed SDK calls with retry/checkpoint tests | vault/crypto/subscription/task capabilities available | accepted |
| Signed package generation | implemented and independently verified | both committed hosts import and execute their packages | accepted for dev publication |

Current local verification is `make check`: Go domain/runtime tests, Rust wire conformance, Node
adapter/UI tests, repository boundary checks, and diff validation. Installed-host acceptance is
separate:

```sh
ZBOARD_ROOT=/path/to/clean/zboard make acceptance-zboard
ZNET_GUI_ROOT=/path/to/clean/gui make acceptance-znet
ZBOARD_ROOT=/path/to/clean/zboard ZNET_GUI_ROOT=/path/to/clean/gui make acceptance-cross-host
```

The accepted evidence uses the same signed package completing installation, configuration,
authorization, subscription delivery, and message synchronization on unmodified host worktrees.
