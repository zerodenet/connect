# ZBoard package

`domain/authorization.go` captures the first server business invariant without depending on a
nonexistent Host API: sessions are bound to one device, user, source, user epoch, and global
epoch; device revocation and either clear operation fail closed. Periodic activity cannot rewrite
the last successful password-login time or IP.

The package manifest is intentionally incomplete (`files` is empty and there is no runtime/UI
payload). Current ZBoard capabilities cannot yet provide governed plugin routes, password
verification, entitled subscription rendering, message audience projection, or durable atomic
revocation across instances. Add the real adapter only after those generic Host APIs exist.
