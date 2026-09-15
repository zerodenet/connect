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
subscription-to-configuration pipeline, and presents provider messages as read-only notifications.

## Compatibility model

- A panel that natively implements the provider contract is directly compatible; it does not need
  to imitate ZBoard endpoints or token behavior.
- A panel without native support may ship a provider adapter, as `zboard/` does initially.
- A client implements the consumer contract once, then maps subscriptions to whichever kernels it
  supports. The provider never chooses or controls that kernel.
- Marketplace host targets describe installable adapter packages, not the set of remote providers
  or kernels compatible with the protocol.

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

## Dev foundation packages

The reproducible dev build creates two signed, installable foundation packages and one unified
marketplace entry. It validates distribution wiring only; its UI and runtime explicitly report
that authorization, subscription synchronization, and messages are not implemented. Packaging is
self-contained in this repository and does not depend on local ZBoard, ZNet Sink, or marketplace
checkouts.

```sh
make keygen
make dev VERSION=0.0.1-dev.YYYYMMDDHHMM
```

`make keygen` writes one local publisher identity in `.local/` for both package formats. Keep it
private and backed up; changing it creates a different publisher identity. The build writes ignored
artifacts to `dist/` and independently verifies both package signatures and payload digests.

Pushing a tag matching `v0.0.1-dev.YYYYMMDDHHMM` runs
`.github/workflows/dev-release.yml`. The workflow tests the repository, builds and verifies both
signed packages, retains a workflow artifact, and publishes the files as a GitHub prerelease. Add
the one-line base64 contents of `.local/publisher.key` as the repository Actions secret
`CONNECT_PUBLISHER_PRIVATE_KEY`. The workflow requests only `contents: write` for release upload;
the signing key is never committed or printed.
