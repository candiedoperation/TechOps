---
sidebar_position: 2
---

# OpenID Provider Configuration

:::warning Mandatory scopes
People Portal needs `openid`, `profile`, `email`, `offline_access`, and a custom
scope named `people_portal`. It requests all five on every authorization, so a
provider missing any of them will not complete a login.
:::

:::note
People Portal is tightly coupled to Authentik, so this guide assumes it. Other
compliant providers work, but the custom scope has to be reproduced by hand.
:::

:::tip Script this instead
`peopleportal/server/scripts/bootstrap-authentik.sh` performs everything below and
is idempotent, so re-running only updates the existing provider. It also gets the
two details that are easy to miss by hand: the logout redirect's type, and which
invalidation flow to bind.

```bash
AK_TOKEN=<authentik api token> ./bootstrap-authentik.sh https://portal.example.com
```

It writes the resulting client id and secret to a gitignored `.oidc` beside
itself. The manual steps remain here because you still need to understand what it
produced.
:::

## The custom scope

`pk`, `is_superuser` and `attributes` are not standard OIDC claims, but the app
reads all three, so they come through a custom scope.

1. **Customization** → **Property Mappings**
2. **Create** → **Scope Mapping**
3. Name `People Portal Scope`, scope name `people_portal`
4. Expression:

```py
return {
    "pk": request.user.pk,
    "is_superuser": request.user.is_superuser,
    "attributes": request.user.attributes
}
```

If this mapping is ever detached, `is_superuser` arrives undefined and reads as
false, which looks like a permissions bug rather than a configuration one.

## Application and provider

1. **Applications** → **Applications** → **Create with Provider**, name it
   **People Portal**
2. Provider type **OAuth2/OpenID Provider**
3. Authorization flow: `default-provider-authorization-implicit-consent`
4. Invalidation flow: **`default-invalidation-flow`**
5. Client type **confidential**. Note the client id and secret
6. Under **Advanced protocol settings**, set the scopes from the warning above,
   and set **Subject mode** to `Based on the User's username`
7. Grant types: `authorization_code` and `refresh_token`

:::danger Not the provider invalidation flow
`default-provider-invalidation-flow` is the tempting choice and it is wrong. It
ships with **zero stages**: it ends the application session and leaves the
Authentik session untouched. Logout then appears to succeed, and the next login
completes silently against the still-live session, dropping the user straight back
in. `default-invalidation-flow` carries the user-logout stage that actually ends
the session.
:::

Without the explicit grant types, `/authorize` answers `Invalid grant_type` with
nothing else to go on.

## Redirect URIs

Two entries, and the **types are not interchangeable**:

| URL | Type |
|---|---|
| `PEOPLEPORTAL_BASE_URL/api/auth/redirect` | `authorization` |
| `PEOPLEPORTAL_BASE_URL/` | `logout` |

Both strict matching. Authentik validates `post_logout_redirect_uri` only against
entries typed `logout`. Registering the landing page with the default
`authorization` type is accepted by the API without complaint and then fails at
logout with a bare **"Bad Request — The request is otherwise malformed"**, naming
neither the URI nor the type.

An unauthenticated probe of the end-session endpoint will not catch this: with no
session it redirects to the authentication flow before the redirect URI is ever
validated. Only a real logout exercises it.

## Environment variables

- `PEOPLEPORTAL_OIDC_CLIENTID` — client id from step 5
- `PEOPLEPORTAL_OIDC_CLIENTSECRET` — client secret from step 5
- `PEOPLEPORTAL_OIDC_DSCVURL` — discovery URL from **Applications** → **People Portal**
