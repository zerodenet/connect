# Connect

Connect is a host-neutral integration protocol plus reference adapters for connecting a
subscription provider to a client. Panels and clients sit at the edge of this contract; the
protocol does not depend on a particular panel brand or proxy kernel.

The first repository release ships two packages:

- `org.zerodenet.connect.zboard`: provider-side reference adapter for ZBoard.
- `org.zerodenet.connect.znet-sink`: client-side reference adapter for ZNet Sink.

A different panel can connect by implementing the provider side of the published protocol. A
different client can implement the consumer side and map delivered subscriptions into its own
configuration pipeline. Kernel selection and execution remain entirely behind the client host;
changing Zero to another kernel does not change the Connect protocol.

The first release authorizes an account, registers a device, renews that authorization, lists
entitled subscriptions, delivers a selected subscription through the client's existing
subscription-to-configuration pipeline, and presents provider messages in a read-only client view
with host notifications for newly unread items.

## Compatibility model

- A panel that natively implements the provider contract is directly compatible; it does not need
  to imitate ZBoard endpoints or token behavior.
- A panel without native support may ship a provider adapter, as `zboard/` does initially.
- A client implements the consumer contract once, then maps subscriptions to whichever kernels it
  supports. The provider never chooses or controls that kernel.
- Marketplace host targets describe installable adapter packages, not the set of remote providers
  or kernels compatible with the protocol.

## Current status

This repository contains the P0 protocol and installable reference adapters for ZBoard and ZNet
Sink. The ZBoard adapter serves its manifest-declared public routes through the host's generic
plugin route API; the client adapter performs provider verification, device authorization, managed
subscription application/manual refresh, read-only messages, and the same renewal/subscription/
message chain under a host-owned scheduled task. The same signed packages have passed installed-
host and cross-product acceptance on committed, unmodified host baselines.

See [the clean-host capability audit](docs/clean-host-capability-audit.md) for the host boundary and
[the plugin capability status](docs/plugin-capability-status.md) for what Connect itself already
implements.

## Layout

```text
protocol/       shared versioned protocol inventory; no host implementation
zboard/         ZBoard package, native provider runtime, pages, and domain code
znet-sink/      ZNet Sink component, signed management page, and binding code
marketplace/    unified-product registration and release templates
tests/interop/  cross-host contract checks and fixtures
docs/           architecture, evidence baselines, gaps, and delivery status
```

Run the dependency-free checks with:

```sh
make check
```

Packaging, signing, publishing, and host installation remain separate gates. No signing key belongs
in this repository. `make dev VERSION=0.0.2-dev.YYYYMMDDHHMM` builds and independently verifies five
ZBoard packages plus one ZNet Sink package only when `zboard/release-readiness.json` records the
accepted committed host baselines. Publication still requires a release tag and a successful GitHub
workflow; a local build alone is not a published Connect release.
