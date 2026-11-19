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

/* Configure ENV Variables before other imports */
import { ENVIRONMENT, isProduction, loadEnvironmentFiles, assertRequiredEnvironment, envInt } from './config/environment'
const loadedEnvFiles = loadEnvironmentFiles()

import express, { Router, Request, Response, NextFunction } from "express"
import cors from "cors"
import { RegisterRoutes } from "./routes";
import { apiReference } from '@scalar/express-api-reference'
import { ValidateError } from "tsoa";
import mongoose from "mongoose";
import { OpenIdClient } from "./clients/OpenIdClient";
import expressSession from 'express-session'
import { generateSecureRandomString } from "./utils/strings";
import path from "path";
import { NativeExpressOIDCAuthPort } from "./auth";
import { AuthentikClient } from "./clients/AuthentikClient";
import { RedisClient } from "./clients/RedisClient";
import { CustomValidationError, ResourceAccessError } from "./utils/errors";
import { ENABLED_SHARED_RESOURCES } from "./config";
import log from 'loglevel';
import { agendaClient } from './clients/AgendaClient';
import { authenticateGiteaWebhook } from './utils/gitea-webhook-auth';
import { describeUnknownError } from './utils/errors';

log.setLevel("info")

assertRequiredEnvironment()
log.info(`Environment: ${ENVIRONMENT}${loadedEnvFiles.length ? ` (loaded ${loadedEnvFiles.join(', ')})` : ''}`)

if (!process.env.PEOPLEPORTAL_TOKEN_SECRET) {
  /* A generated secret changes on every boot, silently invalidating every
     session. Fine locally, never acceptable in production. */
  if (isProduction)
    throw new Error("PEOPLEPORTAL_TOKEN_SECRET must be set in production")

  process.env.PEOPLEPORTAL_TOKEN_SECRET = generateSecureRandomString(16)
  log.warn("PEOPLEPORTAL_TOKEN_SECRET is unset; generated an ephemeral one. Sessions will not survive a restart.")
}

const app = express();
const PORT = envInt('PORT', 3000);

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true
}));

app.set('trust proxy', true);
app.use(
  expressSession({
    name: 'peopleportal_sid',
    secret: process.env.PEOPLEPORTAL_TOKEN_SECRET,
    resave: false,
    saveUninitialized: true,
    store: new expressSession.MemoryStore(), /* Use Redis for Horizontal Scaling */
    proxy: true,
  })
);

/* Register TSOA Routes */
const ApiRouter = Router()
ApiRouter.use("/api/webhook/git/repoevent", authenticateGiteaWebhook)
ApiRouter.use("/api/webhook/git/commitevent", authenticateGiteaWebhook)
ApiRouter.get("/api/docs/swagger.json", async (req, res) => {
  const doc = await import("../dist/swagger.json");
  res.json(doc.default || doc);
});

/* Enable Documentation A */
ApiRouter.use("/api/docs", apiReference({
  spec: {
    url: "/api/docs/swagger.json",
  },

  metaData: {
    title: "People Portal Server API Reference",
  },

  favicon: '/logo.svg',
  showDeveloperTools: "never",
  theme: "kepler",
  hideClientButton: true,
  customCss: `
    a[href="https://www.scalar.com"] {
      display: none;
    }

    div.flex-col:nth-child(4) > div:nth-child(1)::before {
      content: "© 2026 Atheesh Thirumalairajan";
      font-size: small;
      color: var(--scalar-color-3);
    }
  `,

  authentication: {
    /* Must Match Generated OpenAPI Spec from tsoa.json */
    preferredSecurityScheme: 'OIDC Bindle Shim',
  },
}));

/* Register & Setup Catch All Route for Public Dir */
RegisterRoutes(ApiRouter);
app.use(ApiRouter);

app.get(["/onboard", "/onboard/*splat"], (req, res) => {
  res.sendFile(path.join(__dirname, "ui", "index.html"))
})

app.get(["/apply", "/apply/*splat"], (req, res) => {
  res.sendFile(path.join(__dirname, "ui", "index.html"))
})

app.use(express.static(path.join(__dirname, "ui"), { index: false }))

app.get("*splat", NativeExpressOIDCAuthPort, (req, res) => {
  res.sendFile(path.join(__dirname, "ui", "index.html"))
})

app.use(function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): Response | void {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof ValidateError) {
    console.warn(`Caught Validation Error for ${req.path}:`, err.fields);
    return res.status(422).json({
      message: "Validation Failed",
      details: err?.fields
    });
  }

  if (err instanceof ResourceAccessError || err instanceof CustomValidationError) {
    return res.status(err.status).json({
      message: err.message,
    });
  }

  if (err instanceof Error) {
    console.error(err)
    return res.status(500).json({
      message: err.message ?? "Unknown Internal Server Error",
    });
  }

  next();
});

/**
 * Brings up everything the server needs before it can serve a real request.
 *
 * Kept as a named function rather than an inline async listen callback: Express
 * expects `() => void` there, so an async callback returns a promise nobody
 * holds and any rejection inside it becomes an unhandled rejection that kills
 * the process. That is how a bad Discord token used to take the whole server
 * down. Here the promise has an explicit owner and an explicit failure path.
 */
async function startup(): Promise<void> {
  /* Validate Connections */
  await OpenIdClient.init()
  await RedisClient.init()
  //await AuthentikClient.validateAuthentikConnection()

  /* Validate Service Team Creation.
     The app cannot function without its service teams: ExecutiveBoardMembers
     backs the org chart and the executive layer, EventsTeamMembers backs event
     management. Without them a fresh instance shows "Executive Board Not
     Found" and nothing can fix it from the UI.

     This was commented out incidentally in an unrelated commit (7a97511,
     "Updated Session Cookie Name", 2026-02-03), which is why fresh installs
     have needed the groups created by hand. It is idempotent by design,
     treating a duplicate group as success, so running it every boot is safe.
     Isolated because a directory hiccup should degrade the org chart, not
     stop the server from serving. */
  const authentikClient = new AuthentikClient()
  try {
    await authentikClient.validateServiceExistance()
  } catch (e: unknown) {
    log.error("Service team validation failed; executive and events features may be unavailable:", describeUnknownError(e))
  }

  /* Initialize Shared Resource Clients. One integration failing to start must
     not stop the server from serving, so each is isolated. */
  for (const client in ENABLED_SHARED_RESOURCES) {
    log.info(`Initializing Shared Resource Client: ${client}`)
    const clientInstance = ENABLED_SHARED_RESOURCES[client]!;
    try {
      await clientInstance.init()
    } catch (e: unknown) {
      log.error(`Failed to initialize shared resource client "${client}", continuing without it:`, describeUnknownError(e))
    }
  }

  /* Validate Database Connection */
  await mongoose.connect(process.env.PEOPLEPORTAL_MONGO_URL!)
  log.info(`Server running at http://localhost:${PORT}`);

  // Agenda Client Singleton
  await agendaClient.initialize();
}

app.listen(PORT, () => {
  startup().catch((e: unknown) => {
    /* Reaching here means a dependency the server cannot serve without (OIDC
       discovery, Redis, Mongo, the job scheduler) did not come up. Exit
       deliberately with a readable reason rather than dying on an unhandled
       rejection halfway through boot. */
    log.error("Fatal error during startup:", describeUnknownError(e))
    if (e instanceof Error && e.stack) log.error(e.stack)
    process.exit(1)
  })
});
