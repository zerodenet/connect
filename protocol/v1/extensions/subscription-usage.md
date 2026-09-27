# Optional subscription usage extension

`subscriptions.usage` is an optional, read-only Connect v1 operation. A provider advertises it in
the discovery `operations` list only when its host exposes an account-scoped subscription usage
projection. Older clients ignore the extra operation; clients MUST check discovery before calling
it. No existing v1 request or response schema changes.

The request is `{ "subscription_id": string }`, authorized with the same access credential and
device proof as `subscriptions.get-content`. The response is
`{ "subscription_id": string, "used_bytes": integer, "total_bytes": integer,
"expire_at_unix_ms": integer }`. All integers are non-negative and no larger than the JSON
safe-integer limit; `used_bytes` is aggregate provider-reported usage, not an upload/download
split. The provider MUST scope the subscription to the authenticated principal. Unknown or
foreign IDs return `not_found`, without disclosing their existence.

Usage is independent of configuration `revision` and MAY change while content is `not_modified`.
Clients SHOULD refresh it on their configured sync cadence and update only the matching
plugin-owned subscription metadata. They MUST NOT overwrite manual subscriptions or synthesize
upload/download figures from the aggregate.
