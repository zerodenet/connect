# P0 reference-adapter host capability resolution

Connect remains a plugin: it consumes provider-neutral capabilities supplied independently by each
host and does not import host internals, modify host business tables, or call private application
endpoints. The former P0 gaps are resolved in the committed baselines below.

## ZBoard

ZBoard `v0.0.2-rc.202609201141` provides:

- exact manifest-declared public HTTP routes with enable-time conflict detection, request bounds,
  and immediate removal on disable or uninstall;
- bounded password verification returning an account assertion, never a password hash or general
  host token;
- entitled-subscription and read-only message projections through application-owned services;
- authenticated page actions with opaque actor context;
- plugin-private storage and server runtime lifecycle.

The API is generic and is published as
`github.com/zerodenet/zboard/backend/pkg/pluginapi v0.0.1`. Connect registers its own well-known
paths in its signed manifest; ZBoard contains no Connect plugin ID or Connect-specific route.

## ZNet Sink

ZNet Sink commit `8e1972cbfe15579dee631caa607f0a2c4d1fff25` provides:

- configured-origin HTTPS requests;
- host-encrypted persistent credentials and non-exported device cryptography;
- stable managed-subscription identity keyed by plugin, provider and remote subscription;
- owner-checked removal, host notifications, isolated plugin storage, and durable scheduled tasks.

The ordinary configuration schema stores only the host-validated provider origins. Passwords remain
transient, device private keys remain host-owned, and one source cannot overwrite a manual or
foreign-plugin subscription.

## Acceptance

Installed-package tests pass independently on each committed host. Cross-host acceptance installs
the same signed packages and completes provider discovery, device authorization, renewal,
subscription projection/application, and read-only message synchronization without host source
changes. These results open development packaging; they do not claim production deployment or
compatibility with hosts that have not implemented the required public capabilities.
