/**
  People Portal Server
  Copyright (C) 2026  Atheesh Thirumalairajan

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as express from "express";
import { AuthorizedUser, OpenIdClient } from "./clients/OpenIdClient";
import jwt from "jsonwebtoken"
import { BindleController } from "./controllers/BindleController";
import { AuthentikClient } from "./clients/AuthentikClient";
import { ENABLED_SERVICE_TEAM_NAMES } from "./utils/services";
import { ResourceAccessError } from "./utils/errors";
import { formatBindleAccessError } from "./utils/strings";
import { ConstraintViolationException } from "@aws-sdk/client-organizations";
import { hasAdminAuthority } from './config';

export async function NativeExpressOIDCAuthPort(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    /* Obtain Auth Status */
    try {
        const res = await expressAuthentication(req, "oidc")
        next()
    } catch (e: any) {
        /* Auth Exception */
        // Calculate return_to (Protocol + Host + Original URL)
        const returnTo = req.protocol + "://" + req.get("host") + req.originalUrl;
        res.redirect(302, "/api/auth/login?return_to=" + encodeURIComponent(returnTo))
    }
}

export async function expressAuthentication(
    request: express.Request,
    securityName: string,
    scopes?: string[]
): Promise<any> {
    try {
        if (securityName == "oidc")
            return await oidcAuthVerify(request, scopes);

        else if (securityName == "bindles")
            return await bindlesAuthVerify(request, scopes);

        else if (securityName == "events")
            return await eventsAuthVerify(request, scopes);

        else if (securityName == "executive")
            return await executiveAuthVerify(request, scopes);

        else if (securityName == "ats_otp") {
            if (!request.session.tempsession?.jwt || !request.session.tempsession?.user) {
                return Promise.reject(new ResourceAccessError(401, "Session is Invalid"));
            }

            try {
                jwt.verify(request.session.tempsession.jwt, process.env.PEOPLEPORTAL_TOKEN_SECRET!);
                return Promise.resolve(true)
            } catch (error) {
                delete request.session.tempsession;
                return Promise.reject(new ResourceAccessError(401, "Invalid or expired token"));
            }
        }

        else
            throw new Error("Invalid Security Name!")
    } catch (e) {
        return Promise.reject(e)
    }
}

/**
 * Verifies if user has valid OIDC Token. Verification happens as defined in the OpenID
 * standard via the OpenIdClient.
 * 
 * @param request Express Request Object
 * @param scopes Array of Scopes
 * @returns User Authorization Status (Boolean)
 */
async function oidcAuthVerify(request: express.Request, scopes?: string[]): Promise<boolean> {
    try {
        const authToken = request.session.accessToken
        if (!authToken)
            return Promise.reject(new ResourceAccessError(401, "No Token Provided"));

        const userData = await OpenIdClient.verifyAccessToken(authToken)
        if (!request.session.accessToken || !request.session.authorizedUser) {
            request.session.accessToken = authToken
            request.session.authorizedUser = userData
        }

        return Promise.resolve(true)
    } catch (e: any) {
        /* Check for Token Expiration & Refresh Logic */
        if ((e.name === 'TokenExpiredError' || e.message?.includes('expired')) && request.session.refreshToken) {
            try {
                console.log("Access Token Expired. Attempting Refresh...");
                const newTokens = await OpenIdClient.refreshAccessToken(request.session.refreshToken);

                /* Update Session */
                request.session.accessToken = newTokens.accessToken;
                if (newTokens.refreshToken)
                    request.session.refreshToken = newTokens.refreshToken;

                request.session.authorizedUser = newTokens.user;
                request.session.tokenExpiry = newTokens.expiry.getTime();

                return Promise.resolve(true);
            } catch (refreshError) {
                console.error("Token Refresh Failed:", refreshError);
            }
        }

        /* OIDC Authorization Failed! */
        return Promise.reject(new ResourceAccessError(401, "Invalid or expired token"));
    }
}

/**
 * TODO!!
 * 
 * @param request Express Request Object
 * @param scopes Array of Scopes
 * @param skipOidcCheck Skip OIDC Check, Used when called from another OIDC functions.
 * @returns User Authorization Status (Boolean)
 */
export async function executiveAuthVerify(
    request: express.Request,
    scopes?: string[],
    skipOidcCheck?: boolean
): Promise<boolean> {
    if (!skipOidcCheck) {
        const isAuthenticated = await oidcAuthVerify(request, scopes);
        if (!isAuthenticated)
            return Promise.reject(new ResourceAccessError(401, "OIDC Authentication Failed!"));
    }

    if (!request.session.authorizedUser)
        return Promise.reject(new ResourceAccessError(401, "Failed to Fetch OIDC User Information!"));

    /* Fetch User Data */
    const authorizedUser: AuthorizedUser = request.session.authorizedUser;

    /* Superusers are implicitly Executives, Check Scope */
    if (authorizedUser.is_superuser)
        return Promise.resolve(true);

    /* 2. Superuser Exclusive Scope Check */
    if (scopes && scopes.includes("su:exclusive")) {
        /* We already know they are NOT a superuser here */
        return Promise.reject(new ResourceAccessError(403, "This action is restricted to Superusers only!"));
    }

    /* 3. Check for Executive Board Membership */
    /* We fetch the Root Teams for the user */
    const authentikClient = new AuthentikClient();
    try {
        const userTeams = await authentikClient.getRootTeamsForUsername(authorizedUser.username);

        /* Any team carrying admin authority, not flagged for deletion */
        const isExecutive = hasAdminAuthority(userTeams.teams, authorizedUser.groups ?? []);

        if (isExecutive)
            return Promise.resolve(true);

    } catch (e) {
        /* Failed to Fetch Root Teams */
        return Promise.reject(e);
    }

    /* Neither Conditions Work! */
    return Promise.reject(new ResourceAccessError(403, "You must be an Executive Board Member or a Superuser to perform this action!"));
}

/**
 * 
 * 
 * @param request Express Request Object
 * @param scopes Array of Scopes
 * @returns User Authorization Status (Boolean)
 */
export async function eventsAuthVerify(
    request: express.Request,
    scopes?: string[],
    skipOidcCheck?: boolean
): Promise<boolean> {
    /* tsoa hands every request the SAME scopes array instance for a given route,
       so mutating it here (the previous scopes.shift()) permanently stripped the
       flag after one request and silently re-enabled the exec override for all
       later callers. Derive a local copy instead and never touch the argument. */
    let allowExecOverride = true;
    let effectiveScopes = scopes;
    if (scopes && scopes[0] === "NoExecOverride") {
        allowExecOverride = false;
        effectiveScopes = scopes.slice(1);
    }

    if (!skipOidcCheck) {
        const isAuthenticated = await oidcAuthVerify(request, effectiveScopes);
        if (!isAuthenticated)
            return Promise.reject(new ResourceAccessError(401, "OIDC Authentication Failed!"));
    }

    if (!request.session.authorizedUser)
        return Promise.reject(new ResourceAccessError(401, "Failed to Fetch OIDC User Information!"));

    /* Fetch User Data */
    const authorizedUser: AuthorizedUser = request.session.authorizedUser;

    /* Superusers are implicitly Executives, Check Scope */
    if (allowExecOverride && authorizedUser.is_superuser)
        return Promise.resolve(true);

    /* 2. Superuser Exclusive Scope Check */
    if (allowExecOverride && effectiveScopes && effectiveScopes.includes("su:exclusive")) {
        /* We already know they are NOT a superuser here */
        return Promise.reject(new ResourceAccessError(403, "This action is restricted to Superusers only!"));
    }

    /* 3. Check for Executive Board Membership */
    /* We fetch the Root Teams for the user */
    const authentikClient = new AuthentikClient();
    try {
        const userTeams = await authentikClient.getRootTeamsForUsername(authorizedUser.username);

        /* Check if any of the teams are EVENTS and NOT Flagged for Deletion */
        const inEventsTeam = userTeams.teams.some(team =>
            team.name === "Events" &&
            !team.flaggedForDeletion
        );

        if (inEventsTeam)
            return Promise.resolve(true);

        /* If enabled, a user in exec can bypass permission. */
        if (allowExecOverride) {
            /* Any team carrying admin authority, not flagged for deletion */
            const isExecutive = hasAdminAuthority(userTeams.teams, authorizedUser.groups ?? []);

            if (isExecutive)
                return Promise.resolve(true);
        }
        

    } catch (e) {
        /* Failed to Fetch Root Teams */
        return Promise.reject(e);
    }

    /* Neither Conditions Work! */
    return Promise.reject(new ResourceAccessError(403, "You must be an Executive Board Member or a Superuser to perform this action!"));
}

/**
 * Verifies if user has the required bindles. When req.params.teamId exists in the request
 * we automatically process Bindle Authorization for that team. Otherwise, a Dynamic Locator
 * is needed to be present as the first element in scopes to resolve the teamId.
 * 
 * Additionally, since all team actions **must be protected by bindles**, we ensure that the
 * team is not **flagged for deletion** and we also populate a special request bindle field
 * for AuthentikClient call optimizations.
 * 
 * **Authorization Override**
 * The Executive Authorization Layer overrides and automatically approves all Bindle Authorization
 * checks thereby, providing superusers and executive administrators full access. However, for
 * Service Team Bindle Manipulation, we explicitly require the "su:exclusive" scope.
 * 
 * @param request Express Request Object
 * @param scopes Array of Bindles or Dynamic Locator + Bindles
 * @returns User Authorization Status (Boolean)
 */
async function bindlesAuthVerify(request: express.Request, scopes?: string[]): Promise<boolean> {
    /* 1. We Need OIDC Verification by Default (The Superset) */
    const isAuthenticated = await oidcAuthVerify(request, scopes);
    if (!isAuthenticated || !request.session.authorizedUser)
        return Promise.reject(new ResourceAccessError(401, "Invalid or expired token"));

    if (!scopes || scopes.length === 0) {
        return Promise.reject(new ResourceAccessError(403, "Bindle Security Check failed: No Scopes Defined"));
    }

    /* 2. Resolve Team ID & Required Bindles */
    let teamId: string | undefined;
    let requiredBindles: string[] = [];

    if (request.params.teamId) {
        /* Default: Standard REST Path (teams/:teamId) */
        teamId = request.params.teamId;
        requiredBindles = scopes;
    } else {
        /* Fallback: Dynamic Locator Path */
        const locatorPath = scopes[0];
        requiredBindles = scopes.slice(1);

        if (locatorPath) {
            const resolvedId = locatorPath.split(".").reduce((o: any, i) => o?.[i], request);
            if (typeof resolvedId === "string")
                teamId = resolvedId;
        }
    }

    if (!teamId || requiredBindles.length === 0) {
        return Promise.reject(new ResourceAccessError(403, "Bindle Security Check failed: Could not resolve Team ID or missing Required Bindles"));
    }

    const authorizedUser: AuthorizedUser = request.session.authorizedUser;
    const authentikClient = new AuthentikClient();

    try {
        /* Fetch Team Info and Inject for Authentik Call Optimization */
        const teamInfo = await authentikClient.getGroupInfo(teamId);
        request.bindle = {
            teamInfo,
            requestedPermissions: requiredBindles
        }

        /* 2.5. Check if Team is Flagged for Deletion */
        if (teamInfo.attributes.flaggedForDeletion) {
            return Promise.reject(new ResourceAccessError(
                403,
                "This team is flagged for deletion and therefore, is read-only."
            ));
        }

        /* 2.75: Executive Authorization Override */
        /* Since team info is populated, we can now check for override */
        try {
            /* Service Teams are Restricted to Superusers! */
            const teamScopes = ENABLED_SERVICE_TEAM_NAMES.has(teamInfo.name) ? ["su:exclusive"] : [];
            const isExecutive = await executiveAuthVerify(request, teamScopes, true);

            if (isExecutive)
                return Promise.resolve(true);
        } catch (e) {
            /* Failed Executive Override, Continue */
        }

        /* 3. Check Owner (Optimized Recursive Group Name Check) */
        /* Convert user groups to Set for O(1) Lookup */
        const userGroupSet = new Set(authorizedUser.groups);
        let authoritativeTeam = teamInfo;

        /* If Subteam, Elevate to Parent for Ownership Check */
        if (teamInfo.parentPk) {
            authoritativeTeam = await authentikClient.getGroupInfo(teamInfo.parentPk);
        }

        /* Verify PeoplePortal Validity & Check Membership */
        /* Note: We rely on unique Group Names enforced by People Portal */
        if (authoritativeTeam.attributes.peoplePortalCreation) {
            if (userGroupSet.has(authoritativeTeam.name)) {
                return Promise.resolve(true);
            }
        }

        /* 4. Granular Permission Check */
        const effectivePermissions = BindleController.getEffectivePermissionSet(teamInfo, authorizedUser.groups);

        /* Ensure User has ALL required bindles */
        const missingBindles = requiredBindles.filter(bindle => !effectivePermissions.has(bindle));
        if (missingBindles.length === 0)
            return Promise.resolve(true);

        /* Access Denied */
        const owners = authoritativeTeam.users.map(u => u.name);
        return Promise.reject(new ResourceAccessError(403, formatBindleAccessError(owners, missingBindles)));

    } catch (e) {
        console.error("Bindle Permission Check Failed", e);
        if (e instanceof ResourceAccessError) return Promise.reject(e);
        return Promise.reject(new ResourceAccessError(403, "Bindle Permission Check Failed"));
    }
}