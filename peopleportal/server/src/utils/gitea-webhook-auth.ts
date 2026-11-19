import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

export const GITEA_WEBHOOK_AUTHORIZATION_HEADER = "Authorization";
const MIN_GITEA_WEBHOOK_SECRET_LENGTH = 32;

export function getGiteaWebhookAuthorizationHeader(): string {
  const secret = process.env.PEOPLEPORTAL_GITEA_WEBHOOK_SECRET;

  if (!secret || secret.length < MIN_GITEA_WEBHOOK_SECRET_LENGTH) {
    throw new Error(
      `PEOPLEPORTAL_GITEA_WEBHOOK_SECRET must be at least ${MIN_GITEA_WEBHOOK_SECRET_LENGTH} characters long`
    );
  }

  return `Bearer ${secret}`;
}

export function isGiteaWebhookAuthorized(request: Request): boolean {
  let expectedAuthorization: string;

  try {
    expectedAuthorization = getGiteaWebhookAuthorizationHeader();
  } catch (_) {
    return false;
  }

  const suppliedAuthorization = request.get(GITEA_WEBHOOK_AUTHORIZATION_HEADER);
  if (!suppliedAuthorization) return false;

  const expected = Buffer.from(expectedAuthorization, "utf8");
  const supplied = Buffer.from(suppliedAuthorization, "utf8");

  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

export function authenticateGiteaWebhook(request: Request, response: Response, next: NextFunction) {
  if (!isGiteaWebhookAuthorized(request)) {
    return response.status(401).send("Unauthorized");
  }

  return next();
}
