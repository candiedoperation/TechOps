---
sidebar_position: 2
---

# ATS Open Roles Failure

`COE #1` `2/5/26` `Ian Coutinho`

![Empty Open Roles Page](/img/coe/empty-open-roles.png)
<center>*The "Open Roles" page showing no available teams.*</center>

## Timeline

| Time (EST)   | Event                                                                                                                                                                                    |
| :----------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **6:50 PM**  | Incident start. QR code displayed for applications; users reported infinite scrolling on the "Open Roles" page.                                                                          |
| **7:30 PM**  | MongoDB SLA triggered a restart due to high load, resulting in persistent infinite loading states.                                                                                       |
| **7:45 PM**  | Loading ceased; teams/roles stopped showing altogether across the platform.                                                                                                              |
| **8:40 PM**  | Initial database investigation; MongoDB checked for missing documents (incorrectly checked wrong schema).                                                                                |
| **9:30 PM**  | Deep-dive code review initiated to identify failure points.                                                                                                                              |
| **9:50 PM**  | **Mitigation**: Allocated more RAM to the Authentik instance and restarted People Portal workers. Manually saved Team Recruitment Configs to restore the database.                       |
| **11:38 PM** | **Root Cause Identified**: Discovered logic that deletes database documents on Authentik `GROUP_NOT_FOUND` errors, and confirmed Traefik returns 404 during Authentik memory exhaustion. |

## Root Cause Analysis

The root cause was twice-fold:

1. **Infrastructure**: Authentik workers reached memory limits, causing the service to crash.
2. **Logic**: The error handling in the `AuthentikClient` incorrectly assumed that any 404 response meant a group had been deleted in Authentik. It did not account for the reverse proxy (Traefik) returning a 404 when the upstream service was unreachable or misconfigured.

```ts
try {

    ...

} catch (e) {
    if (e instanceof AuthentikClientError && e.code === AuthentikClientErrorType.GROUP_NOT_FOUND) {
        console.warn(`Recruiting Team with PK ${team.teamPk} not found in Authentik. Cleaning up.`);
        await TeamRecruitingStatus.deleteOne({ teamPk: team.teamPk }).exec();
    } else {
        throw e;
    }
}
```

This logic was triggered by the following `catch` block in `AuthentikClient.getGroupInfo`, which converted the Traefik 404 into a `GROUP_NOT_FOUND` error code:

```ts
var RequestConfig: any = {
    ...this.AxiosBaseConfig,
    method: 'get',
    url: `/api/v3/core/groups/${teamId}/`,
    params: {
        /* Avoid Breaking Changes of Including Request Options, Default to True */
        include_users: options?.includeUsers ?? true,
        include_children: options?.includeChildren ?? true,
        include_parents: options?.includeParentInfo ?? false
    }
}

...

try {
    const res = await axios.request(RequestConfig)

    ...

} catch (e) {
    log.error(AuthentikClient.TAG, "Get Teams List Request Failed with Error: ", e)
    if (axios.isAxiosError(e) && e.response?.status === 404)
        throw new AuthentikClientError(AuthentikClientErrorType.GROUP_NOT_FOUND)

    /* We Just Know that the Request Failed! */
    throw new AuthentikClientError(AuthentikClientErrorType.GROUPINFO_REQUEST_FAILED)
}
```

## Supporting Data

### Database State

![MongoDB Empty Collection](/img/coe/empty-mongo-collection.png)
<center>*MongoDB showing 0 documents in the collection.*</center>

MongoDB collection `teamrecruitingstatuses` was found to be empty (0 documents).

### Metrics

![Database Metrics](/img/coe/mongo-metrics-spike.png)
<center>*MongoDB metrics showing activity spike during the incident.*</center>

MongoDB Cloud metrics showed a significant drop in logical size and document count.

## Replication

To verify the root cause, the failure was replicated in a local environment using the following steps:

1.  **Code Analysis**: Identified the logic in `ATSController.ts` that triggers a `deleteOne` operation when an `AuthentikClientError` with code `GROUP_NOT_FOUND` is caught.
2.  **Infrastructure Analysis**: Observed that Traefik returns a 404 response when the Authentik service is unavailable (e.g., due to OOM), and the `AuthentikClient` translates all 404s into `GROUP_NOT_FOUND`.
3.  **Local Environment Setup**:
    ![Docker Desktop Containers](/img/coe/docker-containers.png)

<center>*Docker Desktop showing the stack state during replication.*</center>
    *   Ran Traefik on `localhost` using the source control Docker Compose configuration.
    *   Modified `/etc/hosts` to point `auth.appdevclub.com` to `127.0.0.1`.
    *   Configured Traefik to route traffic to the local Authentik instance.
4.  **Incident Simulation**:
    *   Loaded the `/apply` page successfully while Authentik was running.
    *   Shut down the Authentik container to mimic a crash/resource exhaustion.
    *   Reloaded the `/apply` page.

![Traefik 404 Page](/img/coe/traefik-404.png)
<center>*Traefik returning a 404 response when Authentik is unreachable during the simulation.*</center>

5.  **Result**: The server logs confirmed that the 404 from the proxy was interpreted as a missing group, and subsequent database queries showed that the `TeamRecruitingStatus` documents were deleted.

## Other Implications

- **Reliability**: The system failed in a non-graceful manner. Instead of a "read-only" or "error" state, it performed destructive actions (data deletion) during an partial outage.
- **Security & Integrity**: Data integrity was compromised by the automated cleanup script. The trade-off made to keep the DB "clean" was valued higher than data durability, which proved incorrect in this context.

## Lessons

- **Fail-Safe over Fail-Clean**: Automated deletions should never be triggered by transient network or infrastructure errors.
- **Error Specificity**: 404 errors from a proxy should be distinguished from 404 errors from a known API endpoint.
- **Fire-Drill Verification**: During incident response, ensure verification steps (like checking DB counts) are performed against the correct environment and schema.

## Plan of Action

- **Immediate**: RAM allocation for Authentik increased to 6GB; service restarted.
- **Logic Change**: Updated `AuthentikClient` to verify the `X-Powered-By: Authentik` header on 404 responses before throwing `GROUP_NOT_FOUND`. This ensures that proxy-generated 404s (which lack this header) are treated as generic service errors rather than data-cleanup triggers.

```ts
if (
    axios.isAxiosError(e) &&
    e.response?.status === 404 &&
    e.response?.headers["x-powered-by"] === "authentik"
)
    throw new AuthentikClientError(AuthentikClientErrorType.GROUP_NOT_FOUND);
```
