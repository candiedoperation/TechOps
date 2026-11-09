/**
 * Service authentication for Horizon (T3.1, item 1).
 *
 * Horizon is a pipeline, not a person, so it has no OIDC session. It proves
 * who it is with a shared secret sent as `Authorization: Bearer <token>`,
 * compared against HORIZON_SERVICE_TOKEN.
 */
import crypto from "crypto";

export const HORIZON_SERVICE_TOKEN_ENV = "HORIZON_SERVICE_TOKEN";

/**
 * True only when the header carries exactly the configured token.
 *
 * Both values are hashed before comparing so the comparison always takes the
 * same time and never reveals how long the real token is. When the variable is
 * unset or empty every request is refused, so a missing secret can never mean
 * "no password needed".
 */
export function isHorizonServiceAuthorized(
    authorizationHeader: string | undefined,
    expectedToken: string | undefined = process.env[HORIZON_SERVICE_TOKEN_ENV],
): boolean {
    if (!expectedToken || !authorizationHeader) return false;

    const match = /^Bearer (.+)$/.exec(authorizationHeader);
    if (!match) return false;

    const digest = (value: string) =>
        crypto.createHash("sha256").update(value, "utf8").digest();
    return crypto.timingSafeEqual(digest(match[1]!), digest(expectedToken));
}
