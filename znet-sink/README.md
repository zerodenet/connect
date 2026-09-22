# ZNet Sink package

Connect now uses the client's signed `.zspkg` application package v1: a ZIP with `plugin.json`,
an isolated `javascript-module-v1` component with a separate scheduled-sync module, and separate management HTML and JavaScript files.
The packer signs the root manifest and indexes every file by SHA-256. The previous JSON/Base64
envelope is retained only by the client as a compatibility reader; Connect's build and acceptance
paths no longer produce it. `src/binding.mjs` remains the host-independent source-binding model.
The component's declarative configuration contains only the allowed HTTPS origins. The page
collects the source name and network path and holds account credentials only for the current
authorization attempt. A server-key fingerprint is never a user-editable configuration field.

The signed management page now owns the interactive business flow: configured-origin discovery,
provider identity and signed HPKE-key verification, device-key creation, password authorization,
credential renewal, projected subscription selection, managed-subscription application,
revision-aware manual refresh, and read-only message list/detail viewing. It notifies only for newly
observed unread messages. It performs work only on page load or explicit user actions; there is no
polling loop. Account passwords are held only for the encrypted authorization request and are
cleared from the input immediately afterward.

The proposed client-host contracts are generic: the network grant binds to a manifest-declared
config field, the encrypted vault is publisher/plugin namespaced, crypto methods expose algorithms
rather than Connect operations, and managed subscription identity is `(plugin, provider, remote id)`.
That identity produces a stable `managed-*` subscription and `managed-config-*` configuration, so
it cannot collide with a manually-created URL subscription or imported configuration.

After device authorization the page registers a host-owned 15-minute task. The signed component's
scheduled action uses the same governed network, vault, crypto, subscription and notification SDK
surface to renew, request content with the saved revision, update only the stable managed binding,
and refresh the message summary. Guest CPU/output limits remain separate from bounded host IO, and
failed actions use durable bounded exponential retry checkpoints.

The implemented interactive flow is source address -> automatic service identity binding -> account/password
authorization -> entitled subscription list -> user selection -> managed subscription binding ->
the client's existing subscription synchronization and configuration pipeline. The completed page
also provides explicit revision-aware subscription/message synchronization. The equivalent
page-independent scheduled path has local adapter/host tests and installed-host cross-product
acceptance on ZNet Sink commit `8e1972cbfe15579dee631caa607f0a2c4d1fff25`. The host supplies
configured-origin networking, persistent secrets, device crypto, managed subscriptions,
notifications and scheduled actions through provider-neutral capabilities.

`scripts/prepare_znet_app.py` stages the source tree and fills the component version and entry
digest; the client's `znet-plugin pack` signs it with the local publisher seed. The same staged
structure is used by the installed-host and cross-host acceptance scripts. The package is not
published until those tests and the ZBoard release-readiness gate pass. The legacy Go packer
remains for historical envelope tests but is no longer used for Connect releases.
