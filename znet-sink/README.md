# ZNet Sink package

`src/binding.mjs` implements host-independent source-binding and late-result checks that can be
moved behind the eventual ZNet Sink SDK. The client can render, validate, persist, and pass the
signed manifest's declarative configuration into the isolated component. The current local test
package uses that path to collect a source name, provider HTTPS origin, and network-path
preference. A server-key fingerprint is deliberately not a configuration field: after the source
is saved, the plugin must discover the remote Connect endpoint and establish the service identity
and device-key binding through the authenticated protocol. Username and password are transient
inputs on the plugin's own page and must not be persisted in ordinary configuration.

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

Do not package the example origin or zero source digest for a business release. Package preparation
preserves the declared least-privilege permissions, replaces the source digest, and applies the
publisher signature. The build gate records and verifies the accepted host baselines before
creating artifacts.
