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

import jwt from "jsonwebtoken"
import jwksClient from 'jwks-rsa';
import * as client from 'openid-client'
import { UserAttributeDefinition } from "../AuthentikClient/models";

export interface AuthorizedUser {
  sub: string,
  email: string,
  name: string,
  pk: number,
  attributes: UserAttributeDefinition,
  is_superuser: boolean,
  username: string,
  groups: string[]
}

export interface AuthorizationStamp {
  accessToken: string,
  expiry: Date,
  refreshToken?: string,
  idToken?: string | undefined,
  user: AuthorizedUser
}

export interface RedirectionRequest {
  redirectUrl: URL,
  expectedState: string
}

export class OpenIdClient {
  private static config: client.Configuration | undefined;
  private static code_challenge_method = 'S256'
  private static code_verifier = client.randomPKCECodeVerifier()
  private static code_challenge: string | undefined
  private static redirect_uri: string | undefined
  private static jwksClient: jwksClient.JwksClient | undefined;

  public static async init() {
    this.config = await client.discovery(
      new URL(process.env.PEOPLEPORTAL_OIDC_DSCVURL!),
      process.env.PEOPLEPORTAL_OIDC_CLIENTID!,
      process.env.PEOPLEPORTAL_OIDC_CLIENTSECRET!,
      undefined,
      { execute: [client.allowInsecureRequests] }
    )

    const jwksUri = this.config.serverMetadata().jwks_uri
    if (!jwksUri) {
      throw new Error("OIDC Backend doesn't support JWKS!")
    }

    this.jwksClient = jwksClient({ jwksUri })
    this.code_challenge = await client.calculatePKCECodeChallenge(this.code_verifier)
    this.redirect_uri = `${process.env.PEOPLEPORTAL_BASE_URL}/api/auth/redirect`
  }

  public static startAuthFlow(): RedirectionRequest {
    /* We Init the Module before Accepting Conns */
    if (!this.config || !this.code_challenge)
      throw new Error("OpenID Client is Not Initialized!")

    const expectedState = client.randomState()
    let parameters: Record<string, string> = {
      redirect_uri: this.redirect_uri!,
      scope: 'openid profile email people_portal offline_access',
      code_challenge: this.code_challenge,
      code_challenge_method: this.code_challenge_method,
    }

    parameters.state = expectedState
    let redirectUrl = client.buildAuthorizationUrl(this.config, parameters)
    return { redirectUrl, expectedState }
  }

  public static async issueAuthorizationStamps(currentUrl: URL, expectedState: string): Promise<AuthorizationStamp> {
    let tokens = await client.authorizationCodeGrant(this.config!, currentUrl, {
      pkceCodeVerifier: this.code_verifier,
      idTokenExpected: true,
      expectedState
    })

    const claims = tokens.claims()
    if (!claims)
      throw new Error("Failed to Obtain OIDC Claims!")

    return {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      idToken: tokens.id_token,
      expiry: new Date(claims.exp * 1000),
      user: {
        sub: claims.sub,
        email: claims.email as string,
        name: claims.name as string,
        username: claims.preferred_username as string,
        groups: claims.groups as string[],
        pk: (claims.pk as number),
        attributes: (claims.attributes as unknown as UserAttributeDefinition),
        is_superuser: claims.is_superuser as boolean
      }
    }
  }

  public static verifyAccessToken(accessToken: string): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      jwt.verify(
        accessToken,
        (header, callback) => {
          this.jwksClient?.getSigningKey(header.kid, (err, key) => {
            const signingKey = key?.getPublicKey()
            callback(null, signingKey)
          })
        },

        {
          algorithms: ["RS256"],
          ignoreExpiration: false,
          audience: process.env.PEOPLEPORTAL_OIDC_CLIENTID
        },

        (err, decoded) => {
          if (err) {
            console.log(err)
            reject(err)
          }

          /* Success!! */
          resolve(decoded)
        }
      )
    })
  }

  public static async refreshAccessToken(refreshToken: string): Promise<AuthorizationStamp> {
    if (!this.config)
      throw new Error("OpenID Client is Uninitialized!")

    const tokens = await client.refreshTokenGrant(this.config, refreshToken)
    const claims = tokens.claims()
    if (!claims)
      throw new Error("Failed to Obtain OIDC Claims from Refresh!")

    return {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}), // Rotation might give a new one
      idToken: tokens.id_token,
      expiry: new Date(claims.exp * 1000),
      user: {
        sub: claims.sub,
        email: claims.email as string,
        name: claims.name as string,
        username: claims.preferred_username as string,
        groups: claims.groups as string[],
        pk: (claims.pk as number),
        attributes: (claims.attributes as unknown as UserAttributeDefinition),
        is_superuser: claims.is_superuser as boolean
      }
    }
  }

  public static async getUserInfo(accessToken: string, sub: string) {
    if (!this.config)
      throw new Error("OpenID Client is Uninitialized!")

    return await client.fetchUserInfo(this.config, accessToken, sub)
  }

  /**
   * Builds the RP-initiated logout URL for the provider, so signing out of
   * People Portal also ends the session at the identity provider. Without
   * this, destroying the local session leaves the IdP session alive and the
   * next login completes silently, which reads as "logout did nothing".
   *
   * Returns undefined when the provider advertises no end_session_endpoint,
   * which is the caller's cue to fall back to a local-only logout rather
   * than fail the request.
   *
   * @param idToken The id_token from the session, sent as id_token_hint so
   *                the provider knows which session to end without prompting
   * @returns The provider's logout URL, or undefined if unsupported
   */
  public static buildLogoutUrl(idToken?: string): URL | undefined {
    if (!this.config)
      throw new Error("OpenID Client is Uninitialized!")

    if (!this.config.serverMetadata().end_session_endpoint)
      return undefined

    /* Must be registered on the provider as a redirect uri; see
       scripts/bootstrap-authentik.sh, which registers both this and the
       login callback. */
    const postLogoutRedirectUri = `${process.env.PEOPLEPORTAL_BASE_URL}/`

    return client.buildEndSessionUrl(this.config, {
      post_logout_redirect_uri: postLogoutRedirectUri,
      ...(idToken ? { id_token_hint: idToken } : {}),
    })
  }
}
