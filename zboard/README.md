# ZBoard package

This directory is the ZBoard reference provider adapter; it does not define the shared protocol.
`domain/authorization.go` owns the provider business invariants: sessions are bound to one device,
user, source, user epoch, and global epoch; device revocation and either clear operation fail closed.
Periodic activity cannot rewrite the last successful password-login facts.

`runtime/` is the native provider component. It serves only the two signed-manifest
`/.well-known/zerodenet-connect/v1/*` routes, persists provider identity/device/session/replay state
through host-owned encrypted storage, and reaches ZBoard data exclusively through capability-scoped
account assertion, subscription projection and message projection calls. Passwords are transient;
the plugin stores only opaque credential digests. The account page uses the generic authenticated
page-action bridge to list and revoke only the current user's devices.

The ZBoard package is distributable as a signed development build. ZBoard
`v0.0.2-rc.202609201141` exposes the generic route, account-assertion, subscription-projection and
message-projection capabilities consumed by this runtime. Installed-package and cross-host
acceptance pass without Connect-specific ZBoard source changes.

Connect integrates only through ZBoard's generic plugin contributions. The account
`authorized-devices` page is a `business` page and may be added to account navigation by the host.
The administrator `client-communication` page is a `configuration` page: ZBoard embeds it from the
installed manifest inside the plugin-management configuration flow and must not expose it as a
global administrator business-navigation item. Both pages use generic manifest contributions; the
adapter never patches or requires Connect-specific branches in ZBoard's navigation.
