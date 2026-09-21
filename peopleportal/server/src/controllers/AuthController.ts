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

import * as express from 'express'
import { Request, Controller, Get, Route, SuccessResponse, Security, Post, Body, Tags, Queries, Hidden, Query } from "tsoa";
import { OpenIdClient } from '../clients/OpenIdClient';
import { UserInfoResponse } from 'openid-client';
import { Applicant } from '../models/Applicant';
import { Application } from '../models/Application';
import jwt from "jsonwebtoken"
import { generateSecureRandomString, capitalizeString } from '../utils/strings';
import { AuthentikClient } from '../clients/AuthentikClient';
import { EmailClient } from '../clients/EmailClient';
import { signAvatarUrl } from '../utils/avatars';
import { executiveAuthVerify } from '../auth';
import { describeUnknownError } from '../utils/errors';

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


@Route("/api/auth")
export class AuthController extends Controller {
    private emailClient: EmailClient
    public constructor() {
        super()
        this.emailClient = new EmailClient()
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
    async getUserInfo(@Request() req: express.Request): Promise<CorpUserInfoResponse> {
        if (!req.session.accessToken || !req.session.authorizedUser)
            throw new Error("Unauthorized")

        const userInfo = await OpenIdClient.getUserInfo(req.session.accessToken, req.session.authorizedUser.sub)

        // Remap to CorpUserInfo and sign avatar URL
        const avatarKey = (userInfo as any).attributes?.avatar
        const avatarUrl = await signAvatarUrl(req.session.authorizedUser.pk ?? req.session.authorizedUser.sub, avatarKey)

        let isExecutive = false
        try {
            isExecutive = await executiveAuthVerify(req, [], true)
        } catch {
            isExecutive = false
        }

        return {
            ...userInfo,
            avatar: avatarUrl,
            isExecutive
        }
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
        if (redirect_uri) {
            req.session.tempsession.redirect_uri = redirect_uri;
            if (state)
                req.session.tempsession.state = state;
        }

        if (return_to) {
            /* Only same-host or relative targets: return_to is redirected to
               verbatim after login, so anything else is an open redirect. */
            let safe = return_to.startsWith("/") && !return_to.startsWith("//");
            if (!safe) {
                try { safe = new URL(return_to).host === req.get("host"); } catch { safe = false; }
            }
            if (safe) req.session.tempsession.return_to = return_to;
        }

        let authFlowResponse = OpenIdClient.startAuthFlow()
        if (!authFlowResponse)
            throw new Error("Failed to Compute OIDC Redirect URL")

        /* Perform Redirection */
        const res = (req as any).res as express.Response
        req.session.oidcState = authFlowResponse.expectedState
        return res.redirect(302, authFlowResponse.redirectUrl.toString())
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
        try {
            const fullURL = req.protocol + '://' + req.get('host') + req.originalUrl;
            let authorizationStamp = await OpenIdClient.issueAuthorizationStamps(new URL(fullURL), req.session.oidcState!)
            req.session.accessToken = authorizationStamp.accessToken
            req.session.authorizedUser = authorizationStamp.user
            req.session.tokenExpiry = authorizationStamp.expiry.getTime()
            if (authorizationStamp.refreshToken)
                req.session.refreshToken = authorizationStamp.refreshToken
            if (authorizationStamp.idToken)
                req.session.idToken = authorizationStamp.idToken

            /* Redirect Logic */
            const res = (req as any).res as express.Response
            const tempsession = req.session.tempsession;

            /* Case 0: Simple Return To (App Navigation) */
            if (tempsession?.return_to) {
                const returnTo = tempsession.return_to;
                delete req.session.tempsession?.return_to;
                return res.redirect(302, returnTo);
            }

            /* Case 1: OAuth2 Passthrough (API Docs Portal, Postman, etc.) */
            if (tempsession?.redirect_uri) {
                const redirectUri = new URL(tempsession.redirect_uri);
                const currentOrigin = req.protocol + '://' + req.get('host');

                /* Implicit Flow Injection for OAuth2 Docs */
                /* If the redirect is for our own docs, we inject the dummy token directly using hash fragment */
                if (redirectUri.origin === currentOrigin && redirectUri.pathname.startsWith('/api/docs')) {
                    const hashParams = new URLSearchParams();
                    hashParams.append("access_token", "SessionCookieShimToken");
                    hashParams.append("token_type", "Bearer");
                    hashParams.append("expires_in", "3600");

                    if (tempsession.state)
                        hashParams.append("state", tempsession.state);

                    redirectUri.hash = hashParams.toString();
                } else {
                    /* Standard Code Flow for others (if needed later) or External Redirects */
                    /* Note: We essentially only support our own docs for now */
                    redirectUri.searchParams.append("code", generateSecureRandomString(16));
                    if (tempsession.state)
                        redirectUri.searchParams.append("state", tempsession.state);
                }

                /* Cleanup */
                delete req.session.tempsession?.redirect_uri;
                delete req.session.tempsession?.state;
                return res.redirect(302, redirectUri.toString());
            }

            /* Case 3: Default */
            return res.redirect(302, "/")
        } catch (e) {
            console.log(e)
            throw e
        }
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
    async otpInitRequest(@Body() body: OtpInitRequest, @Request() req: express.Request) {
        const { email } = body;
        const name = capitalizeString(body.name);

        if (!email || !name) {
            this.setStatus(400);
            return { error: "Bad Request", message: "Email and name are required" };
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
            subject: 'App Dev Verification Code',
            templateName: 'AuthOtpSendCode',
            templateVars: {
                name,
                otpCode: otp
            }
        })

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
    async otpVerifyRequest(@Body() body: OtpVerifyRequest, @Request() req: express.Request) {
        const { email, otp } = body;

        // Get tempsession data
        const tempsession = req.session.tempsession || {};

        // Verify OTP from tempsession
        if (!tempsession.otp || !tempsession.otpEmail || !tempsession.otpExpiry ||
            tempsession.otpEmail !== email ||
            tempsession.otp !== otp ||
            Date.now() > tempsession.otpExpiry) {
            this.setStatus(401);
            return { error: "Unauthorized", message: "Invalid or expired OTP" };
        }

        // Find or create applicant
        let applicant = await Applicant.findOne({ email }).exec();

        if (!applicant) {
            applicant = new Applicant({
                email,
                fullName: tempsession.otpName
            });
            await applicant.save();
        }

        // Generate JWT
        const token = jwt.sign(
            { email, name: applicant.fullName, id: applicant._id },
            process.env.PEOPLEPORTAL_TOKEN_SECRET!,
            { expiresIn: "24h" }
        );

        // Store JWT and user info in tempsession
        req.session.tempsession = {
            jwt: token,
            user: {
                email: applicant.email,
                name: applicant.fullName,
                id: applicant._id.toString()
            }
        }

        return {
            name: applicant.fullName,
            email: applicant.email,
            profile: applicant.profile ? Object.fromEntries(applicant.profile) : {}
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
            const decoded = jwt.verify(tempsession.jwt, process.env.PEOPLEPORTAL_TOKEN_SECRET!) as {
                email: string;
                name: string;
                id: string;
            };

            // Find the applicant to get latest data
            const applicant = await Applicant.findById(decoded.id).exec();

            if (!applicant) {
                return { error: "Unauthorized", message: "Applicant not found" };
            }

            const applications = await Application.find({ applicantId: applicant._id }).lean()

            // Fetch subteam and parent names from Authentik
            const authentikClient = new AuthentikClient();
            const applicationsWithNames = await Promise.all(applications.map(async (app: any) => {
                let teamName = app.teamPk;
                try {
                    // 1. Fetch Parent Team Name
                    const teamInfo = await authentikClient.getGroupInfo(app.teamPk);
                    teamName = teamInfo.attributes?.friendlyName || teamInfo.name;
                } catch (e) {
                    console.error(`Failed to fetch team info for ${app.teamPk}`, e);
                }

                // 2. Fetch Subteam Names for Preferences
                const rolePreferencesWithNames = await Promise.all((app.rolePreferences || []).map(async (pref: any) => {
                    let subteamName = pref.subteamPk;
                    try {
                        const subteamInfo = await authentikClient.getGroupInfo(pref.subteamPk);
                        subteamName = subteamInfo.attributes?.friendlyName || subteamInfo.name;
                    } catch (e) {
                        console.error(`Failed to fetch subteam info for ${pref.subteamPk}`, e);
                    }
                    return { ...pref, subteamName };
                }));

                // 3. Map subteam preferences (legacy support or if frontend needs it)
                // For the new UI, we mostly care about rolePreferencesWithNames
                return {
                    ...app,
                    teamName: teamName,
                    rolePreferences: rolePreferencesWithNames
                };
            }));

            return {
                name: applicant.fullName,
                email: applicant.email,
                profile: applicant.profile ? Object.fromEntries(applicant.profile) : {},
                applications: applicationsWithNames
            };
        } catch (error) {
            // JWT is invalid or expired
            return { error: "Unauthorized", message: "Session expired or invalid" };
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
            console.error("Failed building provider logout URL:", describeUnknownError(e));
        }

        return new Promise((resolve) => {
            req.session.destroy(() => {
                resolve({ message: "Logged out successfully", logoutUrl });
            });
        });
    }
}