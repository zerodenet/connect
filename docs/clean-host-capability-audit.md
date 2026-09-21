# Clean-host capability audit

Connect is a plugin product. Its acceptance boundary is the public plugin API of an unchanged host;
changes made directly in ZNet Sink or ZBoard are not Connect deliverables and cannot be used as
release evidence.

The accepted baselines are committed host versions checked out without source modifications:

| Host | Frozen commit | Published identity |
| --- | --- | --- |
| ZNet Sink | `c0dd6a506f48bc280a04668bf4c7fe12b85c3e34` | `v0.0.2-dev.202609210148` |
| ZBoard | `7da9cfb861b6699c08e649b718f1bfd363b0fb00` | `v0.0.2-rc.202609210457` |

## ZNet Sink

| Connect requirement | Public capability | Result |
| --- | --- | --- |
| Per-source requests to a configured provider | `network.configured.request` | passed |
| Persistent credentials | `secrets.persistent.read` / `secrets.persistent.write` | passed |
| Non-exported device identity and protocol crypto | `crypto.device.use` | passed |
| Stable plugin-owned subscription delivery | `subscriptions.manage` | passed |
| Plugin state and notification | plugin storage and `notifications.post` | passed |
| Scheduled action | `tasks.schedule` | passed |

The signed component never writes application configuration directly. Managed subscription identity
is host-owned and scoped by plugin, provider, and remote subscription.

## ZBoard

| Connect requirement | Public capability | Result |
| --- | --- | --- |
| Public discovery/exchange endpoints | `zboard.http.route.v1` | passed |
| Bounded password verification | `zboard.account.assertion.v1` | passed |
| Entitled subscription projection | `zboard.subscription.projection.v1` | passed |
| Read-only account message projection | `zboard.message.projection.v1` | passed |
| Account/admin UI contribution | `zboard.ui.page.v1` plus generic page actions | passed |
| Plugin configuration and private storage | `zboard.config.v1` / `zboard.storage.v1` | passed |

Routes are exact signed-manifest declarations. The host rejects conflicts while enabling a plugin,
resolves requests only to the active isolated runtime, and removes reachability when the plugin is
disabled or uninstalled. Business projections go through ZBoard application services; Connect has
no database handle or private host endpoint.

## Release decision

The same signed packages pass import, configuration, authorization, subscription, and message
acceptance on both baselines, including the cross-host flow. Development packaging is therefore
enabled. Stable or production readiness remains a separate release decision.
