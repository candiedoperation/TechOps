---
sidebar_position: 2
---

# Bindle Authorization Layer

The Bindle Authorization Layer is the core security mechanism for the People Portal. It enables granular, resource-specific permission management (Bindles) on top of the standard OIDC authentication. It allows teams to manage access to shared resources (like GitHub repositories, Slack channels, etc.) by assigning specific "bindles" to subteams.

:::tip Interested in Internal Workings?
This documentation provides a logical overview of the Bindle Authorization Layer. For detailed API usage and implementation details refer to the [People Portal API Reference](https://corp.appdevclub.com/api/docs).
:::

## Security Middleware Operation

The Bindle Security Middleware intercepts requests to protected routes. It verifies the user's identity via OIDC, resolves the target team context, and enforces fine-grained permissions.

### Authorization Flow Sequence

The following diagram illustrates the detailed sequence of operations when a request hits a Bindle-protected endpoint.

```mermaid
sequenceDiagram
    participant Client
    participant Express as Express Middleware
    participant Auth as Auth Module (auth.ts)
    participant OIDC as OIDC Client
    participant Authentik as Authentik Client
    participant BindleCtrl as Bindle Controller

    Client->>Express: Request (Protected Route)
    Note over Client,Express: Route requires specific Bindles<br/>(e.g., "repo:allowcreate")

    Express->>Auth: expressAuthentication("bindles", scopes)

    rect rgba(0, 150, 255, 0.1)
        note right of Auth: 1. Base Authentication
        Auth->>Auth: oidcAuthVerify(request)
        Auth->>OIDC: Verify Access Token
        OIDC-->>Auth: User Data (AuthorizedUser)
    end

    alt Invalid Token
        Auth-->>Express: Reject (401 Unauthorized)
        Express-->>Client: 401 Unauthorized
    else Token Valid
        rect rgba(255, 200, 0, 0.1)
            note right of Auth: 2. Context Resolution
            Auth->>Auth: Resolve Team ID & Required Bindles
            Note right of Auth: Extracts Team ID from URL params<br/>or Dynamic Locator
        end

        rect rgba(0, 255, 100, 0.1)
            note right of Auth: 3. Team Information Fetch
            Auth->>Authentik: getGroupInfo(teamId)
            Authentik-->>Auth: Team Information (Attributes, Subteams, Users)
            Auth->>Auth: Inject TeamInfo into Request Context<br/>(request.bindle)
        end

        rect rgba(255, 50, 50, 0.1)
            note right of Auth: 4. Deletion Check
            alt Team Flagged for Deletion
                Auth-->>Express: Reject (403 Forbidden)
                Express-->>Client: 403 Read-Only Error
            end
        end

        rect rgba(200, 200, 200, 0.1)
            note right of Auth: 5. Owner Bypass Check & Executive Authorization Layer Override
            Auth->>Auth: Check Recursive Object Ownership
            alt User is Owner (or Parent Team Owner)
                Auth-->>Express: Resolve (Allow Access - Bypass Checks)
            else User is Not Owner
                 rect rgba(150, 100, 255, 0.1)
                    note right of Auth: 6. Granular Permission Check
                    Auth->>BindleCtrl: getEffectivePermissionSet(teamInfo, userGroups)
                    loop For Each Subteam
                        BindleCtrl->>BindleCtrl: Check Member of Subteam?
                        BindleCtrl->>BindleCtrl: Merge Enabled Bindles from Subteam Attributes
                    end
                    BindleCtrl-->>Auth: Effective Permission Set

                    Auth->>Auth: Compare Required vs Effective Bindles
                    alt All Bindles Present
                        Auth-->>Express: Resolve (Allow Access)
                    else Missing Bindles
                        Auth-->>Express: Reject (403 Forbidden)
                        Express-->>Client: 403 Access Denied
                    end
                 end
            end
        end

    end

    Express->>Client: Response
```

## Everything Bindles

"Bindles" are the atomic units of permission within the People Portal ecosystem. They represent a specific capability within a shared resource (e.g., `repo:allowcreate` for Gitea, `slack:allowpost` for Slack).

### Bindle Definitions

Bindles are defined by `SharedResourceClient` implementations. Each client (Gitea, Slack, Apple Account, etc.) defines the bindles it supports.

**Structure of a Bindle:**

```ts
export interface BindlePermission {
    friendlyName: string; // Human readable name for UI
    description: string; // Detailed description of what this permission allows
}
```

**Example: Gitea Client Definitions**
In `src/clients/GiteaClient/index.ts`, the supported bindles are strictly typed and exported:

```ts
private readonly supportedBindles: BindlePermissionMap = {
    "repo:allowcreate": {
        friendlyName: "Allow Repository Creation",
        description: "Enabling this allows members in this subteam to create repositories",
    },
    // ... other bindles
}
```

### Registering Shared Resources

For a Bindle to be recognized by the system, its Client must be registered in the global configuration at `src/config.ts`. This registry allows the `BindleController` to aggregate all available permissions dynamically.

```ts
// src/config.ts
export const ENABLED_SHARED_RESOURCES: { [key: string]: SharedResourceClient } =
    {
        giteaClient: new GiteaClient(),
        peoplePortalClient: new PeoplePortalClient(),
        // ... other clients
    };
```

### Team Attribute Storage

Bindle assignments are stored directly on the Team (or Subteam) objects within Authentik as `attributes`. This allows permissions to persist alongside the group structure.

**Data Layout in Authentik Attributes:**

```json
{
    "bindlePermissions": {
        "GiteaClient": {
            "repo:allowcreate": true,
            "repo:allowsome": false
        },
        "SlackClient": {
            "channel:create": true
        }
    }
}
```

### SharedResourceClient Interface

To implement a new integration that supports Bindles, you must implement the `SharedResourceClient` interface.

```ts
export interface SharedResourceClient {
    // Unique identifier for the client (used as the key in attributes)
    getResourceName(): string;

    // Returns the map of permissions this client supports
    getSupportedBindles(): BindlePermissionMap;

    // Callback to synchronize state when permissions/memberships change
    handleOrgBindleSync(
        org: GetGroupInfoResponse,
        callback: (updatedResourceCount: number, status: string) => void,
    ): Promise<boolean>;
}
```

### Effective Permission Calculation

The `BindleController.getEffectivePermissionSet` method is responsible for flattening the complex hierarchy of subteams and assignments into a simple set of active permissions for a user.

It performs the following logic:

1.  **Iterates** through all subteams of the target team.
2.  **Checks** if the user is a member of that subteam (O(1) lookup).
3.  **Aggregates** all enabled bindles from the subteams the user is a part of.
4.  **Returns** a Set of strings (e.g., `{"repo:allowcreate", "slack:join"}`).

This "Effective Permission Set" is what the middleware checks against the required scopes.

### Extending the System

To add a new Bindle:

1.  **Choose or Create Client**: Identify the `SharedResourceClient` that manages the resource (or create a new one in `src/clients/`).
2.  **Define Bindle**: Add the new permission key and description to the `supportedBindles` map in the client.
3.  **Implement Logic**: Update the `handleOrgBindleSync` method in your client to actually _enforce_ or _sync_ this permission to the external service (e.g., calling the Gitea API to add a user to a team with write access).
4.  **Register (if new client)**: Add valid instance to `ENABLED_SHARED_RESOURCES` in `src/config.ts`.
