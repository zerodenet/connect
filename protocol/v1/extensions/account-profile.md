# Optional account profile extension

`account.me` is a read-only Connect v1 operation advertised in discovery only
when the provider can read the authenticated account's public profile. The
request body is `{}` and requires an access credential and device proof. The
response is `{ "user_id": string, "email": string }`. The provider derives
the account from the authenticated session; clients cannot supply an account ID.
The result is private and must not be logged or stored in diagnostics.

Clients may show the email in their connection management UI. If the operation
is absent, they should show that the provider does not expose account details.
