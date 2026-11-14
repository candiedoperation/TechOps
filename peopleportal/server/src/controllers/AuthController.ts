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
import {
    Request,
    Controller,
    Get,
    Route,
    SuccessResponse,
    Security,
    Post,
    Body,
    Tags,
    Queries,
    Hidden,
    Query,
} from "tsoa";
import { OpenIdClient } from "../clients/OpenIdClient";
import { UserInfoResponse } from "openid-client";
import { Applicant } from "../models/Applicant";
import { Application } from "../models/Application";
import jwt from "jsonwebtoken";
import { generateSecureRandomString, capitalizeString } from "../utils/strings";
import { AuthentikClient } from "../clients/AuthentikClient";
import { EmailClient } from "../clients/EmailClient";
import { signAvatarUrl } from "../utils/avatars";
import { executiveAuthVerify } from "../auth";
import { describeUnknownError } from "../utils/errors";

import { logger } from "../utils/logger";

const log = logger.child({ module: "AuthController" });

export interface CorpUserInfoResponse extends UserInfoResponse {
    avatar: string;
    isExecutive: boolean;
}

interface OtpInitRequest {
    email: string;
    name: string;
}

interface OtpVerifyRequest {
    email: string;
    otp: string;
}

/**
 * Resolves a post-login redirect target against the server's own origin.
 * Returns the same-origin path (with query and fragment) when the target is
 * a single-slash relative path or an absolute URL on this origin, and
 * undefined for anything else so callers fall back to their default.
 *
 * @param target Raw redirect value supplied by the caller
 * @param origin This server's origin, e.g. https://portal.example.com
 * @returns Same-origin path, or undefined when the target is not acceptable
 */
export function resolveSameOriginPath(
    target: string | undefined,
    origin: string,
): string | undefined {
    if (!target) return undefined;

    let base: URL;
    try {
        base = new URL(origin);
    } catch {
        return undefined;
    }

    /* Relative targets must be a single leading slash: "//" and "/\" are
       both parsed as protocol-relative hosts by browsers. */
    const isRelative = target.startsWith("/");
    if (isRelative && /^\/[\/\\]/.test(target)) return undefined;

    let parsed: URL;
    try {
        parsed = new URL(target, base);
    } catch {
        return undefined;
    }

    if (parsed.origin !== base.origin) return undefined;
    if (!parsed.pathname.startsWith("/")) return undefined;

    return parsed.pathname + parsed.search + parsed.hash;
}

/**
 * Projects an application record onto the fields the applicant portal
 * displays. Team and subteam names are resolved by the caller.
 *
 * @param app Application record (lean) with resolved names attached
 * @returns Applicant-facing view of the application
 */
export function toApplicantApplication(app: {
    _id: unknown;
    teamPk: string;
    teamName?: string;
    rolePreferences?: {
        role: string;
        subteamPk: string;
        subteamName?: string;
    }[];
    stage: string;
    appliedAt?: Date;
    responses?: Record<string, string>;
    hiredRole?: string;
    hiredSubteamPk?: string;
}) {
    return {
        _id: app._id,
        teamPk: app.teamPk,
        teamName: app.teamName,
        rolePreferences: (app.rolePreferences || []).map((pref) => ({
            role: pref.role,
            subteamPk: pref.subteamPk,
            subteamName: pref.subteamName,
        })),
        stage: app.stage,
        appliedAt: app.appliedAt,
        responses: app.responses || {},
        hiredRole: app.hiredRole,
        hiredSubteamPk: app.hiredSubteamPk,
    };
}

@Route("/api/auth")
export class AuthController extends Controller {
    private emailClient: EmailClient;
    public constructor() {
        super();
        this.emailClient = new EmailClient();
    }

    /**
     * Returns the user info of the currently authenticated user. Uses the
     * Express Session Cookie and User Scopes provided by the OpenID Connect
     * Authorization Server.
     *
     * @param req Express Request Object
     * @returns User Info Response
     */
    @Get("userinfo")
    @Tags("Core Authentication")
    @Security("oidc")
    @SuccessResponse(200)
    async getUserInfo(
        @Request() req: express.Request,
    ): Promise<CorpUserInfoResponse> {
        if (!req.session.accessToken || !req.session.authorizedUser)
            throw new Error("Unauthorized");

        const userInfo = await OpenIdClient.getUserInfo(
            req.session.accessToken,
            req.session.authorizedUser.sub,
        );

        // Remap to CorpUserInfo and sign avatar URL
        const avatarKey = (userInfo as any).attributes?.avatar;
        const avatarUrl = await signAvatarUrl(
            req.session.authorizedUser.pk ?? req.session.authorizedUser.sub,
            avatarKey,
        );

        let isExecutive = false;
        try {
            isExecutive = await executiveAuthVerify(req, [], true);
        } catch {
            isExecutive = false;
        }

        return {
            ...userInfo,
            avatar: avatarUrl,
            isExecutive,
        };
    }

    /**
     * Primary endpoint to initiate the People Portal OIDC Authentication Flow. This routine
     * accepts redirection parameters, generates the required Authentication Flow parameters
     * from the OpenID Connect Authentication server and redirects to it to continue with authentication.
     *
     * Once this process is completed, the OpenID Connect Authentication Server usually redirects
     * to the /api/auth/redirect endpoint which handles the final steps as defined in the next method.
     *
     * @param req Express Request Object
     * @param redirect_uri Post-Login Redirect URL
     * @returns Redirects to the OpenID Connect Authorization Server
     */
    @Get("login")
    @Tags("Core Authentication")
    @SuccessResponse(302, "Redirect")
    async handleLogin(
        @Request() req: express.Request,
        @Query() redirect_uri?: string,
        @Query() return_to?: string,

        /** OpenID Connect Shim for API Docs. Ignored for other API Requests. */
        @Query() state?: string,

        /* These are hidden parameters used for OIDC Shim */
        @Query() @Hidden() _client_id?: string,
        @Query() @Hidden() _response_type?: string,
    ) {
        /* Capture Redirect Context */
        req.session.tempsession = req.session.tempsession || {};
        const currentOrigin = req.protocol + "://" + req.get("host");

        /* Both targets are redirected to after login, so only same-origin
           paths are kept; anything else falls through to the default. */
        const safeRedirectUri = resolveSameOriginPath(
            redirect_uri,
            currentOrigin,
        );
        if (safeRedirectUri) {
            req.session.tempsession.redirect_uri =
                currentOrigin + safeRedirectUri;
            if (state) req.session.tempsession.state = state;
        }

        const safeReturnTo = resolveSameOriginPath(return_to, currentOrigin);
        if (safeReturnTo) req.session.tempsession.return_to = safeReturnTo;

        let authFlowResponse = OpenIdClient.startAuthFlow();
        if (!authFlowResponse)
            throw new Error("Failed to Compute OIDC Redirect URL");

        /* Perform Redirection */
        const res = (req as any).res as express.Response;
        req.session.oidcState = authFlowResponse.expectedState;
        return res.redirect(302, authFlowResponse.redirectUrl.toString());
    }

    /**
     * Handles the OpenID Connect callback, exchanges the code for a session,
     * and redirects the user to the requested endpoint or root.
     *
     * **Non-standard Behavior:**
     * If the user is logging in via the API Docs, we inject a "Shim Token" (SessionCookieShimToken)
     * into the URL fragment. This is to trick the API Docs into unlocking the authorized state.
     * However, since all authentication and authorization works over the Session Cookie,
     * the shim doesn't impact security or the actual requests.
     *
     * @param req Express Request Object
     * @returns Express Redirection
     */
    @Get("redirect")
    @Tags("Core Authentication")
    @SuccessResponse(302, "Redirect")
    async handleRedirect(@Request() req: express.Request) {
        /* Failures go to the global error handler, which logs them. */
        const fullURL =
            req.protocol + "://" + req.get("host") + req.originalUrl;
        let authorizationStamp = await OpenIdClient.issueAuthorizationStamps(
            new URL(fullURL),
            req.session.oidcState!,
        );
        req.session.accessToken = authorizationStamp.accessToken;
        req.session.authorizedUser = authorizationStamp.user;
        req.session.tokenExpiry = authorizationStamp.expiry.getTime();
        if (authorizationStamp.refreshToken)
            req.session.refreshToken = authorizationStamp.refreshToken;
        if (authorizationStamp.idToken)
            req.session.idToken = authorizationStamp.idToken;

        /* Redirect Logic */
        const res = (req as any).res as express.Response;
        const tempsession = req.session.tempsession;

        const currentOrigin = req.protocol + "://" + req.get("host");

        /* Case 0: Simple Return To (App Navigation) */
        const returnTo = resolveSameOriginPath(
            tempsession?.return_to,
            currentOrigin,
        );
        delete req.session.tempsession?.return_to;
        if (returnTo) return res.redirect(302, returnTo);

        /* Case 1: OAuth2 Passthrough (API Docs Portal, Postman, etc.) */
        const redirectPath = resolveSameOriginPath(
            tempsession?.redirect_uri,
            currentOrigin,
        );
        if (redirectPath) {
            const redirectUri = new URL(redirectPath, currentOrigin);

            /* Implicit Flow Injection for OAuth2 Docs */
            /* If the redirect is for our own docs, we inject the dummy token directly using hash fragment */
            if (redirectUri.pathname.startsWith("/api/docs")) {
                const hashParams = new URLSearchParams();
                hashParams.append("access_token", "SessionCookieShimToken");
                hashParams.append("token_type", "Bearer");
                hashParams.append("expires_in", "3600");

                if (tempsession?.state)
                    hashParams.append("state", tempsession.state);

                redirectUri.hash = hashParams.toString();
            } else {
                /* Standard Code Flow for others (if needed later) or External Redirects */
                /* Note: We essentially only support our own docs for now */
                redirectUri.searchParams.append(
                    "code",
                    generateSecureRandomString(16),
                );
                if (tempsession?.state)
                    redirectUri.searchParams.append("state", tempsession.state);
            }

            /* Cleanup */
            delete req.session.tempsession?.redirect_uri;
            delete req.session.tempsession?.state;
            return res.redirect(302, redirectUri.toString());
        }

        /* Case 3: Default */
        delete req.session.tempsession?.redirect_uri;
        delete req.session.tempsession?.state;
        return res.redirect(302, "/");
    }

    /**
     * Initiates Guest Authentication into People Portal. This routine generates
     * a 6-digit Verification Code and sends it to the user's email. Primarily
     * used for authentication during Recruitment Applications.
     *
     * @param body Guest Authentication Initation Request
     * @param req Express Request Object
     * @returns Status Message
     */
    @Post("otpinit")
    @Tags("Guest Authentication")
    @SuccessResponse(200)
    async otpInitRequest(
        @Body() body: OtpInitRequest,
        @Request() req: express.Request,
    ) {
        const { email } = body;
        const name = capitalizeString(body.name);

        if (!email || !name) {
            this.setStatus(400);
            return {
                error: "Bad Request",
                message: "Email and name are required",
            };
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Initialize tempsession if it doesn't exist
        req.session.tempsession = req.session.tempsession || {};

        // Store OTP data in tempsession
        req.session.tempsession.otp = otp;
        req.session.tempsession.otpEmail = email;
        req.session.tempsession.otpName = name;
        req.session.tempsession.otpExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes

        /* Send OTP Via Email to User */
        await this.emailClient.send({
            to: email,
            subject: "App Dev Verification Code",
            templateName: "AuthOtpSendCode",
            templateVars: {
                name,
                otpCode: otp,
            },
        });

        return { message: "Verification Code sent successfully" };
    }

    /**
     * Verifies the 6-digit Verification Code sent to the user's email, signs a
     * JSON Web Token (JWT) to establish an authenticated session and creates the
     * user's guest profile in the database, if it doesn't exist.
     *
     * The profile generation transforms the user from an unknown guest into a
     * verified applicant in the database.
     *
     * @param body Guest Authentication Verification Request
     * @param req Express Request Object
     * @returns Status Message
     */
    @Post("otpverify")
    @Tags("Guest Authentication")
    @SuccessResponse(200)
    async otpVerifyRequest(
        @Body() body: OtpVerifyRequest,
        @Request() req: express.Request,
    ) {
        const { email, otp } = body;

        // Get tempsession data
        const tempsession = req.session.tempsession || {};

        // Verify OTP from tempsession
        if (
            !tempsession.otp ||
            !tempsession.otpEmail ||
            !tempsession.otpExpiry ||
            tempsession.otpEmail !== email ||
            tempsession.otp !== otp ||
            Date.now() > tempsession.otpExpiry
        ) {
            this.setStatus(401);
            return { error: "Unauthorized", message: "Invalid or expired OTP" };
        }

        // Find or create applicant
        let applicant = await Applicant.findOne({ email }).exec();

        if (!applicant) {
            applicant = new Applicant({
                email,
                fullName: tempsession.otpName,
            });
            await applicant.save();
        }

        // Generate JWT
        const token = jwt.sign(
            { email, name: applicant.fullName, id: applicant._id },
            process.env.PEOPLEPORTAL_TOKEN_SECRET!,
            { expiresIn: "24h" },
        );

        // Store JWT and user info in tempsession
        req.session.tempsession = {
            jwt: token,
            user: {
                email: applicant.email,
                name: applicant.fullName,
                id: applicant._id.toString(),
            },
        };

        return {
            name: applicant.fullName,
            email: applicant.email,
            profile: applicant.profile
                ? Object.fromEntries(applicant.profile)
                : {},
        };
    }

    /**
     * Verifies the guest authentication session and returns the user's profile.
     * Additionally, we enumerate the user's ATS applications and return them.
     *
     * @param req Express Request Object
     * @returns User Profile and ATS Applications
     */
    @Get("verifyotpsession")
    @Tags("Guest Authentication", "Applicant Portal")
    @SuccessResponse(200)
    async otpVerifySession(@Request() req: express.Request) {
        const tempsession = req.session.tempsession;

        // Check if tempsession and JWT exist
        if (!tempsession?.jwt) {
            return { error: "Unauthorized", message: "No active session" };
        }

        try {
            // Verify the JWT
            const decoded = jwt.verify(
                tempsession.jwt,
                process.env.PEOPLEPORTAL_TOKEN_SECRET!,
            ) as {
                email: string;
                name: string;
                id: string;
            };

            // Find the applicant to get latest data
            const applicant = await Applicant.findById(decoded.id).exec();

            if (!applicant) {
                return {
                    error: "Unauthorized",
                    message: "Applicant not found",
                };
            }

            const applications = await Application.find({
                applicantId: applicant._id,
            }).lean();

            // Fetch subteam and parent names from Authentik
            const authentikClient = new AuthentikClient();
            const applicationsWithNames = await Promise.all(
                applications.map(async (app: any) => {
                    let teamName = app.teamPk;
                    try {
                        // 1. Fetch Parent Team Name
                        const teamInfo = await authentikClient.getGroupInfo(
                            app.teamPk,
                        );
                        teamName =
                            teamInfo.attributes?.friendlyName || teamInfo.name;
                    } catch (e) {
                        log.error(
                            { err: e, teamPk: app.teamPk },
                            "Failed to fetch team info",
                        );
                    }

                    // 2. Fetch Subteam Names for Preferences
                    const rolePreferencesWithNames = await Promise.all(
                        (app.rolePreferences || []).map(async (pref: any) => {
                            let subteamName = pref.subteamPk;
                            try {
                                const subteamInfo =
                                    await authentikClient.getGroupInfo(
                                        pref.subteamPk,
                                    );
                                subteamName =
                                    subteamInfo.attributes?.friendlyName ||
                                    subteamInfo.name;
                            } catch (e) {
                                log.error(
                                    { err: e, subteamPk: pref.subteamPk },
                                    "Failed to fetch subteam info",
                                );
                            }
                            return { ...pref, subteamName };
                        }),
                    );

                    // 3. Project onto the fields the applicant portal displays
                    return toApplicantApplication({
                        ...app,
                        teamName: teamName,
                        rolePreferences: rolePreferencesWithNames,
                    });
                }),
            );

            return {
                name: applicant.fullName,
                email: applicant.email,
                profile: applicant.profile
                    ? Object.fromEntries(applicant.profile)
                    : {},
                applications: applicationsWithNames,
            };
        } catch (error) {
            // JWT is invalid or expired
            return {
                error: "Unauthorized",
                message: "Session expired or invalid",
            };
        }
    }

    /**
     * Destroys the User's session and returns the provider's logout URL so
     * the caller can complete RP-initiated logout.
     *
     * The local session is destroyed either way. `logoutUrl` is present only
     * when the provider advertises an end_session_endpoint; the client should
     * navigate to it when given one, and treat its absence as a completed
     * local logout rather than an error. Ending the identity provider's
     * session matters because otherwise the next login completes silently
     * against the still-live IdP session, which on a shared machine looks
     * like logout never happened.
     *
     * The id_token is read before the session is destroyed, since it is the
     * id_token_hint that lets the provider end the right session without
     * prompting the user.
     *
     * @param req Express Request Object
     * @returns Status message, and the provider logout URL when available
     */
    @Post("logout")
    @Tags("Core Authentication")
    @SuccessResponse(200)
    async handleLogout(@Request() req: express.Request) {
        const idToken = req.session.idToken;

        let logoutUrl: string | undefined;
        try {
            logoutUrl = OpenIdClient.buildLogoutUrl(idToken)?.href;
        } catch (e: unknown) {
            /* A provider problem must not strand the user in a logged-in
               session: fall through to the local logout below. */
            log.error(
                { err: describeUnknownError(e) },
                "Failed building provider logout URL",
            );
        }

        return new Promise((resolve) => {
            req.session.destroy(() => {
                resolve({ message: "Logged out successfully", logoutUrl });
            });
        });
    }
}
