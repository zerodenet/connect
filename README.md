# ZBoard for ZNet Sink

This repository is the implementation home for the ZBoard dual-host plugin. One product ships
two packages:

- `org.zerodenet.zboard.server`: the ZBoard service plugin and its account/admin pages.
- `org.zerodenet.zboard`: the ZNet Sink client plugin.

The first release connects explicitly configured ZBoard sources to ZNet Sink, performs
password authorization over the plugin protocol, registers a device, renews that authorization,
lists entitled subscriptions, delivers the selected subscription through the client's existing
subscription-to-configuration pipeline, and presents source messages as read-only notifications.

## Current status

This initial repository implements the P0 foundation, not an installable v0.0.1 package. It
contains stable product/package identities, a shared operation inventory, server-side
authorization invariants, client-side source-binding commit guards, marketplace templates, and
tests. The host capability gaps recorded in [docs/host-gaps.md](docs/host-gaps.md) intentionally
block packaging until the two hosts expose the required generic APIs.

## Layout

```text
protocol/       shared versioned protocol inventory; no host implementation
zboard/         ZBoard package intent and server-side domain code
znet-sink/      ZNet Sink package intent and client-side binding code
marketplace/    unified-product registration and release templates
tests/interop/  cross-host contract checks and fixtures
docs/           architecture, evidence baselines, gaps, and delivery status
```

Run the dependency-free checks with:

```sh
make check
```

Packaging, signing, publishing, and host installation are deliberately separate later gates.
No signing key belongs in this repository.
