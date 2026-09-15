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

import { Controller, Get, Queries, Route, Security, SuccessResponse, Tags } from "tsoa";
import { AuthentikClient } from "../clients/AuthentikClient";
import { GiteaClient } from "../clients/GiteaClient";
import { GiteaAPIUserDefinition, GiteaRepository } from "../clients/GiteaClient/models";
import { TeamType, TeamInformationDetail } from "../clients/AuthentikClient/models";
import {
    APIProjectCatalogOptions,
    createProjectCatalogEntry,
    projectCatalogIdentityIssues,
    ProjectCatalogRepositorySnapshot,
    ProjectCatalogResponse,
} from "../models/ProjectCatalog";
import { ResourceAccessError } from "../utils/errors";

@Route("/api/projects")
export class ProjectCatalogController extends Controller {
    private readonly authentikClient: AuthentikClient;
    private readonly giteaClient: GiteaClient | null;

    constructor() {
        super();
        this.authentikClient = new AuthentikClient();
        this.giteaClient = process.env.PEOPLEPORTAL_GITEA_ENDPOINT && process.env.PEOPLEPORTAL_GITEA_TOKEN
            ? new GiteaClient()
            : null;
    }

    /**
     * Provides a neutral project-to-ownership projection for monorepo
     * consumers. Authentik owns team identity and membership; Gitea is queried
     * only for repositories under the organization's canonical namespace and
     * its member roster for exact-email identity joins.
     */
    @Get("catalog")
    @Tags("Project Catalog")
    @SuccessResponse(200)
    @Security("oidc")
    @Security("service")
    async getProjectCatalog(@Queries() options: APIProjectCatalogOptions): Promise<ProjectCatalogResponse> {
        const observedAt = new Date();
        let teams: TeamInformationDetail[];

        try {
            const response = await this.authentikClient.getGroupsListDetail({
                limit: 1000,
                includeUsers: true,
                ...(options.includeArchived !== undefined && { includeArchived: options.includeArchived }),
            });
            teams = response.teams.filter((team) =>
                team.teamType === TeamType.PROJECT &&
                (options.includeArchived === true || (!team.archivedAt && !team.flaggedForDeletion))
            );
        } catch (error) {
            console.error("Failed to fetch project teams for catalog", error);
            throw new ResourceAccessError(503, "Project catalog source is unavailable");
        }

        const projectSnapshots = await Promise.all(teams.map(async (team) => ({
            team,
            snapshot: await this.getRepositorySnapshot(team.name),
        })));
        const snapshotsByProject = new Map(projectSnapshots.map(({ team, snapshot }) => [team.pk, snapshot]));
        const projects = projectSnapshots.map(({ team, snapshot }) =>
            createProjectCatalogEntry(team, snapshot, observedAt));

        return {
            observedAt,
            projects,
            identityIssues: projectCatalogIdentityIssues(teams, snapshotsByProject),
        };
    }

    private async getRepositorySnapshot(organization: string): Promise<ProjectCatalogRepositorySnapshot> {
        if (!this.giteaClient) {
            return {
                status: "unconfigured",
                repositories: [],
                memberStatus: "unconfigured",
                members: [],
            };
        }

        try {
            const repositories = await this.giteaClient.getOrganizationRepositories(organization);
            let members: GiteaAPIUserDefinition[];
            let memberStatus: ProjectCatalogRepositorySnapshot["memberStatus"];
            try {
                members = await this.giteaClient.getOrganizationMembers(organization);
                memberStatus = "verified";
            } catch (error) {
                console.warn(`Failed to read Gitea members for ${organization}`, error);
                members = [];
                memberStatus = "unavailable";
            }

            return {
                status: "verified",
                repositories: repositories
                    .filter((repository) => repository.owner.username === organization)
                    .map((repository) => this.toRepositoryReference(repository)),
                memberStatus,
                members: members.map((member) => this.toMemberReference(member)),
            };
        } catch (error) {
            console.warn(`Failed to read Gitea repositories for ${organization}`, error);
            return {
                status: "unavailable",
                repositories: [],
                memberStatus: "unavailable",
                members: [],
            };
        }
    }

    private toRepositoryReference(repository: GiteaRepository) {
        return {
            id: repository.id,
            slug: repository.name,
            fullName: repository.full_name,
            ...(repository.html_url && { url: repository.html_url }),
            archived: repository.archived,
        };
    }

    private toMemberReference(member: GiteaAPIUserDefinition) {
        const providerId = member.id !== undefined && member.id !== null
            ? String(member.id).trim()
            : undefined;
        const username = typeof member.login === "string" && member.login.trim()
            ? member.login.trim()
            : undefined;
        const email = typeof member.email === "string" ? member.email : undefined;

        return {
            provider: "gitea" as const,
            ...(providerId ? { providerId } : {}),
            ...(username ? { username } : {}),
            ...(email !== undefined ? { email } : {}),
        };
    }
}
