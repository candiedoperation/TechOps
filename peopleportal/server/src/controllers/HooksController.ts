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

import {
    Route,
    Controller,
    Get,
    SuccessResponse,
    Post,
    Body,
    Tags,
} from "tsoa";
import {
    GiteaHookCommitTrigger,
    GiteaHookRepositoryTrigger,
} from "../clients/GiteaClient/models";
import { GiteaClient } from "../clients/GiteaClient";
import { AuthentikClient } from "../clients/AuthentikClient";

import { logger } from "../utils/logger";

const log = logger.child({ module: "HooksController" });

@Route("/api/webhook")
export class HooksController extends Controller {
    /* How recently a personal repository must have been created for its
       creation event to delete it. Webhooks arrive within seconds; the margin
       covers queueing and clock skew, and an older repository is never touched
       by a replayed or forged event. */
    static readonly PERSONAL_REPO_DELETE_WINDOW_MS = 10 * 60 * 1000;

    private readonly giteaClient: GiteaClient;
    private readonly authentikClient: AuthentikClient;

    constructor() {
        super();
        this.giteaClient = new GiteaClient();
        this.authentikClient = new AuthentikClient();
    }

    @Post("git/repoevent")
    @Tags("Git Web Hooks")
    @SuccessResponse(200)
    async processGitRepoEventHook(
        @Body() repoEvent: GiteaHookRepositoryTrigger,
    ) {
        switch (repoEvent.action) {
            case "created":
                return this.handleRepoCreation(repoEvent);

            default:
                return "OK";
        }
    }

    @Post("git/commitevent")
    @Tags("Git Web Hooks")
    @SuccessResponse(200)
    async processGitMainCommitEventHook(
        @Body() commitEvent: GiteaHookCommitTrigger,
    ) {
        if (
            commitEvent.ref !== GiteaClient.GIT_REF_MAINBRANCH ||
            commitEvent.before !== GiteaClient.GIT_NULL_COMMITID
        ) {
            /* Not Main Branch or First Commit */
            return "OK";
        }

        try {
            const ownerName = commitEvent.repository.owner.username;
            const repository = await this.giteaClient.getRepository(
                ownerName,
                commitEvent.repository.name,
            );
            if (
                repository.id !== commitEvent.repository.id ||
                repository.owner.username !== ownerName
            ) {
                throw new Error("Repository does not match webhook event");
            }

            const teamPk =
                await this.authentikClient.getGroupPkFromName(ownerName);
            const teamInfo = await this.authentikClient.getGroupInfo(teamPk);

            /* Apply Branch Protections now that main exists */
            await this.giteaClient.handleBranchProtectionSync(teamInfo, [
                repository,
            ]);
        } catch (e: any) {
            /* Potential Group Not Found Error! We're good, not mission critical. */
            log.error(
                { err: e, repository: commitEvent.repository.full_name },
                "Failed applying branch protection",
            );
        }

        return "OK";
    }

    private async handleRepoCreation(repoEvent: GiteaHookRepositoryTrigger) {
        /* Gitea fills `organization` with the owner even for personal
           repositories, so ask the API which kind of owner this is. */
        let ownerIsOrganization: boolean;
        try {
            ownerIsOrganization = await this.giteaClient.isOrganization(
                repoEvent.repository.owner.username,
            );
        } catch (e: any) {
            log.error(
                { err: e, repository: repoEvent.repository.full_name },
                "Failed resolving the repository owner",
            );
            return "OK (Actions Failed)";
        }

        if (!ownerIsOrganization)
            return this.handlePersonalRepoCreation(repoEvent);

        try {
            const organizationName = repoEvent.organization.username;
            if (repoEvent.repository.owner.username !== organizationName) {
                throw new Error(
                    "Repository owner does not match webhook organization",
                );
            }

            /* Resolve both resources authoritatively before applying privileged changes. */
            await this.authentikClient.getGroupPkFromName(organizationName);
            const repository = await this.giteaClient.getRepository(
                organizationName,
                repoEvent.repository.name,
            );
            if (
                repository.id !== repoEvent.repository.id ||
                repository.owner.username !== organizationName
            ) {
                throw new Error("Repository does not match webhook event");
            }

            await this.giteaClient.handleRepoProvisioning({
                ...repoEvent,
                repository,
            });
        } catch (e: any) {
            /* Processing failed; leave the repository untouched for an authorized operator to review. */
            log.error(
                { err: e, repository: repoEvent.repository.full_name },
                "Failed provisioning repository",
            );
            return "OK (Actions Failed)";
        }
    }

    /**
     * Team code lives in team organizations, so personal repositories are
     * deleted as soon as they are created. The delete only happens once the API
     * confirms the event describes a repository that exists with the same id
     * and owner, belongs to a user rather than an organization, and was
     * created within PERSONAL_REPO_DELETE_WINDOW_MS. Anything else is logged
     * and left alone, so a forged or replayed event cannot delete an older or
     * different repository.
     */
    private async handlePersonalRepoCreation(
        repoEvent: GiteaHookRepositoryTrigger,
    ) {
        const ownerName = repoEvent.repository.owner.username;
        try {
            const repository = await this.giteaClient.getRepository(
                ownerName,
                repoEvent.repository.name,
            );
            if (
                repository.id !== repoEvent.repository.id ||
                repository.owner.username !== ownerName
            ) {
                throw new Error("Repository does not match webhook event");
            }

            const age = Date.now() - Date.parse(repository.created_at);
            if (
                !Number.isFinite(age) ||
                Math.abs(age) > HooksController.PERSONAL_REPO_DELETE_WINDOW_MS
            ) {
                throw new Error("Repository was not created just now");
            }

            await this.giteaClient.deleteRepository(ownerName, repository.name);
            log.warn(
                { repository: repository.full_name },
                "Deleted personal repository: team code belongs in a team organization",
            );
            return "OK (Personal Repository Deleted)";
        } catch (e: any) {
            log.error(
                { err: e, repository: repoEvent.repository.full_name },
                "Not deleting personal repository",
            );
            return "OK (Actions Failed)";
        }
    }
}
