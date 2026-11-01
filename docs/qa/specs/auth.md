# Admin authentication

The one admin account per deployment, its sessions, and the check every admin route makes (`AGENTS.md` §1). Seeded by the walking-skeleton project (#6). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `AUTH`

## The admin account

- `[AUTH-1]` `[seed]` The admin account comes only from the deployment's configuration: no route creates, claims or resets an admin account, and there is no setup page and no sign-up.
- `[AUTH-2]` `[seed]` The login checks the password against a memory-hard hash read from the deployment's configuration, in constant time and without calling the database, and the plaintext password is never stored, logged or returned.

## Every admin route

- `[AUTH-3]` `[seed]` Every admin route (each page, route handler and server action) refuses, before its handler runs, a request with no session cookie, a request whose session cookie fails its signature check, and a request carrying an `x-middleware-subrequest` header; the test enumerates the routes from the app directory and fails when it finds none.
- `[AUTH-4]` `[seed]` Every route of the app is either on the public allow-list (the login and `/health/live`) or behind the admin check, and a route that is neither fails the test.
- `[AUTH-5]` `[seed]` The admin check runs in the server code of each admin route and in every service function that changes data, and never in middleware alone.
- `[AUTH-6]` `[seed]` A request with no session cookie, a request whose session cookie fails its signature check, and a failed or rate-limited login attempt never call the database.
- `[AUTH-7]` `[seed]` A state-changing admin request whose origin is not the admin's own is refused.

## Sessions

- `[AUTH-8]` `[seed]` A session id holds at least 128 bits from a cryptographically secure generator and is stored on the server; the cookie carries only the signed id and is `HttpOnly`, `Secure` and `SameSite`.
- `[AUTH-9]` `[seed]` Logout revokes the session on the server: the same cookie, replayed after logout, is refused.
- `[AUTH-10]` `[seed]` Changing the admin password in the deployment's configuration and deploying ends every session that existed before.
- `[AUTH-11]` `[seed]` A session ends once its idle lifetime or its absolute lifetime has passed, both set by the deployment's configuration and checked on the server.

## Login rate limiting

- `[AUTH-12]` `[seed]` Login attempts are limited per client address and in total; once a limit is reached, further attempts are refused with 429 without checking the password until the window has passed, the limiter's state is kept outside Aurora, and each refusal logs the `businessEvent` `auth.login.rate_limited`.
