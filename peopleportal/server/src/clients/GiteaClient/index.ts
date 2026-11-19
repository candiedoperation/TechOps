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

import axios, { AxiosError } from "axios"
import { SharedResourceClient } from ".."
import { GetGroupInfoResponse } from "../AuthentikClient/models"
import { GiteaAPITeamDefinition, GiteaAPIUserDefinition, GiteaBranchProtection, GiteaHookRepositoryTrigger, GiteaRepository, GiteaRepositoryBrief } from "./models";
import { computeStringArrStateDiff } from "../../utils/operations";
import { BindlePermission, BindlePermissionMap } from "../../controllers/BindleController";
import { GiteaHookSetup } from "./hooksetup";
import { GITEA_DEFAULT_BRANCH_PROTECTION, GITEA_DEFAULT_ORG_NAME } from "./config";

class GiteaClientResourceNotExists extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GiteaClientResourceNotExists";
    }
}

interface GiteaOrgCreateRequest {
    grpSharedResourceId: string,
    displayName: string,
    orgWebsite: string
}

interface GiteaTeamCreateRequest {
    grpSharedResourceId: string,
    teamSharedResourceId: string,
    canCreateRespositories: boolean,
    description: string,
    writeAccess: boolean
}

export class GiteaClient implements SharedResourceClient {
    private static INITIALIZED = false
    private static readonly TAG = "GiteaClient"
    private GITEA_TOKEN = process.env.PEOPLEPORTAL_GITEA_TOKEN

    public static readonly GIT_NULL_COMMITID = "0000000000000000000000000000000000000000"
    public static readonly GIT_REF_MAINBRANCH = "refs/heads/main"
    public static readonly GIT_NAME_MAINBRANCH = "main"

    public readonly GiteaBaseConfig = {
        baseURL: process.env.PEOPLEPORTAL_GITEA_ENDPOINT ?? "",
        maxBodyLength: Infinity,
        headers: {
            'Accept': "application/json",
            'Authorization': `Bearer ${this.GITEA_TOKEN}`
        }
    }

    private readonly supportedBindles: BindlePermissionMap = {
        "repo:allowcreate": {
            friendlyName: "Allow Repository Creation",
            description: "Enabling this allows members in this subteam to create repositories",
        },

        "repo:brprotect-approvals": {
            friendlyName: "Allow Pull Request Approvals",
            description: "Enabling this allows members in this subteam to approve and review PRs"
        },

        "repo:brprotect-merge": {
            friendlyName: "Allow Git Merge",
            description: "Enabling this allows members in this subteam to merge Pull Requests"
        },

        "repo:brprotect-override": {
            friendlyName: "Override Branch Protections",
            description: "Dangerous: Allows members to bypass all Branch Protections thereby, significantly reducing code quality",
        },
    }

    constructor() {
        if (!this.GiteaBaseConfig.baseURL)
            throw new Error("Gitea Backend URL is Invalid!")

        if (!this.GITEA_TOKEN)
            throw new Error("Gitea Token is Invalid!")
    }

    async init(): Promise<void> {
        if (!GiteaClient.INITIALIZED) {
            await GiteaHookSetup.setupHooks(this.GiteaBaseConfig)
            GiteaClient.INITIALIZED = true
        }
    }

    getResourceName(): string {
        return GiteaClient.TAG
    }

    getSupportedBindles(): BindlePermissionMap {
        return this.supportedBindles
    }

    public async handleOrgBindleSync(org: GetGroupInfoResponse, callback: (updatedResourceCount: number, status: string) => void): Promise<boolean> {
        /* If the Org's Not Created, Create it! */
        await this.ensureOrganizationExists({
            grpSharedResourceId: org.name,
            displayName: `${org.attributes.friendlyName} ${org.attributes.seasonType} ${org.attributes.seasonYear}`,
            orgWebsite: `${process.env.PEOPLEPORTAL_BASE_URL}/org/teams/${org.pk}`
        })

        /* Perform Team Bindle Sync & Apply Branch Protections */
        await this.handleTeamBindleSync(org, org.name, callback)
        await this.handleBranchProtectionSync(org);
        return true
    }

    /**
     * Archives the team's Gitea organization by marking every repository as
     * archived (read-only). Repository data is preserved; only write access is
     * revoked. Reports progress per repository through the callback.
     *
     * @param org Team Information
     * @param callback Progress Reporting Callback
     */
    public async archiveTeam(org: GetGroupInfoResponse, callback: (updatedResourceCount: number, status: string) => void): Promise<boolean> {
        let repositories: GiteaRepository[]
        try {
            repositories = await this.getOrgRepositories(org.name)
        } catch (error: any) {
            /* No organization (and therefore no repos) to archive */
            if (error instanceof GiteaClientResourceNotExists)
                return true

            throw error
        }

        for (const repository of repositories) {
            try {
                var ArchiveRepoRequestConfig: any = {
                    ...this.GiteaBaseConfig,
                    method: 'patch',
                    url: `/api/v1/repos/${org.name}/${repository.name}`,
                    data: { archived: true }
                };

                await axios.request(ArchiveRepoRequestConfig);
                callback(1, "Git Repository Archived: " + repository.name);
            } catch (error: any) {
                if (!(error instanceof GiteaClientResourceNotExists)) {
                    callback(0, "Git Repository Archival Failed for " + repository.name);
                    console.error(`[GiteaClient] Failed to archive repository ${repository.name}:`, error.message);
                }
            }
        }

        return true
    }

    /**
     * Creates a team if doesn't exist and syncs the team members. Translates Bindle Permissions
     * to the Organization's Rules.
     * 
     * @param team 
     * @param orgRoot If Org Root, we create a fake resource to map the root team members
     * @param callback 
     * @returns 
     */
    private async handleTeamBindleSync(team: GetGroupInfoResponse, orgId: string, callback: (updatedResourceCount: number, status: string) => void): Promise<boolean> {
        /* We'll put team owners in the Shared Owners Team so, People Portal has Supreme Access */
        const teamSharedResourceId = (orgId == team.name) ? GITEA_DEFAULT_ORG_NAME : team.name

        /* Team Deletion Synchronization */
        if (team.attributes?.flaggedForDeletion === true) {
            try {
                const teamInfoBrief = await this.getTeamInfo(orgId, teamSharedResourceId)
                var DeleteTeamRequestConfig: any = {
                    ...this.GiteaBaseConfig,
                    method: 'delete',
                    url: `/api/v1/teams/${teamInfoBrief.id}`,
                };

                await axios.request(DeleteTeamRequestConfig);
                callback(1, "Git Team Deleted for " + teamSharedResourceId);
            } catch (error: any) {
                if (!(error instanceof GiteaClientResourceNotExists)) {
                    callback(0, "Git Team Deletion Failed for " + teamSharedResourceId);
                    console.error(`[GiteaClient] Failed to delete team ${teamSharedResourceId}:`, error.message);
                }
            }

            /* Halt further sync for deleted team */
            return true;
        }

        /* Dynamically Calculate Capabilities */
        const bindles = team.attributes?.bindlePermissions?.[this.getResourceName()] || {};
        const canCreateRespositories = bindles["repo:allowcreate"] === true;
        const writeAccess = canCreateRespositories ||
            bindles["repo:brprotect-approvals"] === true ||
            bindles["repo:brprotect-override"] === true ||
            bindles["repo:brprotect-merge"] === true;


        await this.ensureTeamExists({
            teamSharedResourceId,
            canCreateRespositories,
            description: `Permissions Group Replication for ${teamSharedResourceId}`,
            grpSharedResourceId: orgId,
            writeAccess
        })

        /* Obtain Current Team Members */
        const teamInfoBrief = await this.getTeamInfo(orgId, teamSharedResourceId)
        const teamMemberList = await this.getTeamMembers(teamInfoBrief.id)

        /* Map Objects to Obtain Usernames */
        const finalStateUsernames = team.users.map((user) => user.username)
        const currentStateUsernames = teamMemberList.map((member) => member.login)

        /* Perform User Delta Operations */
        const { additions, deletions } = computeStringArrStateDiff(finalStateUsernames, currentStateUsernames)
        for (const username of additions) {
            this.addTeamMember(teamInfoBrief.id, username)
                .then(() => callback(1, "Git Permissions Updated for " + username))
                .catch(() => callback(1, "Git Permission Update Failed for " + username))
        }

        for (const username of deletions) {
            this.removeTeamMember(teamInfoBrief.id, username)
                .then(() => callback(1, "Git Permissions Updated for " + username))
                .catch(() => callback(1, "Git Permission Update Failed for " + username))
        }

        /* Increased Processed Count for Existing Elements */
        const existingCount = finalStateUsernames.length - additions.length
        callback(existingCount, "Git Permissions Updated for " + teamInfoBrief.name)

        /* Recurse Sub Teams */
        for (const subteam of team.subteams ?? []) {
            await this.handleTeamBindleSync(subteam, orgId, callback)
        }

        /* We're Good Now! */
        return true
    }

    /**
     * Provisions a newly created repository to comply with People Portal standards.
     * If requests fail, we throw the errors as-is without catching. The callee is
     * expected to delete the newly created repository considering standards mismatch.
     * 
     * @param repoEvent Gitea Repository Event
     */
    public async handleRepoProvisioning(repoEvent: GiteaHookRepositoryTrigger) {
        /* 1. Remove the creator from the collaborators list so team permissions take over */
        var DeleteCollabRequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'delete',
            url: `/api/v1/repos/${repoEvent.repository.owner.username}/${repoEvent.repository.name}/collaborators/${repoEvent.sender.username}`,
        };

        /* 2. Apply standard repository settings: Public Visibility and Main default branch */
        var PatchRepoRequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'patch',
            url: `/api/v1/repos/${repoEvent.repository.owner.username}/${repoEvent.repository.name}`,
            data: {
                private: false,
                default_branch: GiteaClient.GIT_NAME_MAINBRANCH,
            }
        };

        /* Execute Both Requests */
        await axios.request(DeleteCollabRequestConfig);
        await axios.request(PatchRepoRequestConfig);
    }

    public async handleBranchProtectionSync(
        team: GetGroupInfoResponse,
        repositories?: GiteaRepositoryBrief[],
    ) {
        if (!repositories)
            repositories = await this.getOrgRepositories(team.name)

        /* Define Base List */
        const approvals_whitelist_teams = [GITEA_DEFAULT_ORG_NAME]
        const merge_whitelist_teams = [GITEA_DEFAULT_ORG_NAME]
        const push_whitelist_teams = [GITEA_DEFAULT_ORG_NAME]

        /* Enumerate Permissions from Team Information */
        for (const subteam of team.subteams ?? []) {
            const bindlePermissions = subteam.attributes?.bindlePermissions?.[this.getResourceName()]
            if (!bindlePermissions)
                continue;

            if (bindlePermissions["repo:brprotect-approvals"] === true)
                approvals_whitelist_teams.push(subteam.name)

            if (bindlePermissions["repo:brprotect-merge"] === true)
                merge_whitelist_teams.push(subteam.name)

            if (bindlePermissions["repo:brprotect-override"] === true)
                push_whitelist_teams.push(subteam.name)
        }

        /* Define Branch Protection Rules, Apply Default Override */
        const branchProt: GiteaBranchProtection = {
            approvals_whitelist_teams,
            merge_whitelist_teams,
            push_whitelist_teams,
            ...GITEA_DEFAULT_BRANCH_PROTECTION
        }

        /* Apply Branch Protection Rules */
        await this.applyBranchProtections(repositories, branchProt)
    }

    /**
     * Applies Branch Protection Rules to a List of Repositories. If the repository
     * is empty we skip branch protections thereby allowing the first "main" merge.
     * 
     * On commit, if a main branch already exists, we apply the branch protections
     * as requested in `branchProt`.
     * 
     * @param repositories List of Repositories
     * @param branchProt Branch Protection Rules
     */
    private async applyBranchProtections(
        repositories: GiteaRepositoryBrief[],
        branchProt: GiteaBranchProtection
    ) {
        for (const repositorynt of repositories) {
            const repository = repositorynt as GiteaRepository;

            /* Bypass Branch Protection for Empty Repositories, They're Applied using Push Hooks */
            if (repository.empty === true)
                continue;

            var updateRequestConfig: any = {
                ...this.GiteaBaseConfig,
                method: 'patch',
                url: `/api/v1/repos/${repository.owner.username}/${repository.name}/branch_protections/${branchProt.rule_name}`,
                data: branchProt,
            }

            try {
                /* Apply Branch Protection Update */
                await axios.request(updateRequestConfig)
            } catch (e: any) {
                if (!e.response || e.response.status != 404)
                    throw e;

                /* Branch Protection Doesn't Exist, Create it! */
                var createRequestConfig: any = {
                    ...this.GiteaBaseConfig,
                    method: 'post',
                    url: `/api/v1/repos/${repository.owner.username}/${repository.name}/branch_protections`,
                    data: branchProt,
                }

                /* Excecute Request, Throws on Error! */
                await axios.request(createRequestConfig)
            }
        }
    }

    /**
     * Fetches all repositories owned by an organization.
     * Uses the Gitea API internally.
     * 
     * @param orgName Shared Resource ID
     * @returns Repository List
     */
    private async getOrgRepositories(orgName: string): Promise<GiteaRepository[]> {
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'get',
            url: `/api/v1/orgs/${orgName}/repos`,
        }

        /* Excecute Request */
        const response = await axios.request(RequestConfig)
        return response.data as GiteaRepository[]
    }

    private async addTeamMember(teamId: number, username: string) {
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'put',
            url: `/api/v1/teams/${teamId}/members/${username}`,
        }

        /* Excecute Request */
        await axios.request(RequestConfig)
    }

    private async removeTeamMember(teamId: number, username: string) {
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'delete',
            url: `/api/v1/teams/${teamId}/members/${username}`,
        }

        /* Excecute Request */
        await axios.request(RequestConfig)
    }

    private async ensureTeamExists(req: GiteaTeamCreateRequest): Promise<boolean> {
        try {
            const teamInfo = await this.getTeamInfo(req.grpSharedResourceId, req.teamSharedResourceId);
            const expectedPermission = req.writeAccess ? "write" : "read";

            /* Check for drift and apply updates if necessary */
            if (teamInfo.description !== req.description ||
                teamInfo.permission !== expectedPermission ||
                teamInfo.can_create_org_repo !== req.canCreateRespositories) {

                var UpdateRequestConfig: any = {
                    ...this.GiteaBaseConfig,
                    method: 'patch',
                    url: `/api/v1/teams/${teamInfo.id}`,
                    data: {
                        name: req.teamSharedResourceId,
                        description: req.description,
                        permission: expectedPermission,
                        can_create_org_repo: req.canCreateRespositories,
                        units: ["repo.actions", "repo.code", "repo.issues", "repo.pulls", "repo.releases", "repo.projects"],
                        includes_all_repositories: true
                    }
                }

                await axios.request(UpdateRequestConfig);
            }

            return true;
        } catch (error: any) {
            if (!(error instanceof GiteaClientResourceNotExists))
                throw error
        }

        /* Team Doesn't Exist, Create it! */
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'post',
            url: `/api/v1/orgs/${req.grpSharedResourceId}/teams`,
            data: {
                name: req.teamSharedResourceId,
                description: req.description,
                permission: req.writeAccess ? "write" : "read",
                can_create_org_repo: req.canCreateRespositories,
                units: ["repo.actions", "repo.code", "repo.issues", "repo.pulls", "repo.releases", "repo.projects"],
                includes_all_repositories: true,
            }
        }

        /* Throws an Exception! */
        await axios.request(RequestConfig)
        return true;
    }

    private async ensureOrganizationExists(req: GiteaOrgCreateRequest): Promise<boolean> {
        try {
            /* Try to Obtain Org Info */
            const orgInfo = await this.getOrganizationInfo(req.grpSharedResourceId)

            /* Check if we need to update the organization */
            const description = `Code Repository for the ${req.displayName} team.  \nManaged by [**People Portal**](https://github.com/candiedoperation/AppDev-PeoplePortalServer).`

            if (orgInfo.full_name != req.displayName || orgInfo.website != req.orgWebsite || orgInfo.description != description) {
                await this.updateOrganization(req)
            }

            return true;
        } catch (error: any) {
            if (!(error instanceof GiteaClientResourceNotExists)) {
                throw error
            }
        }

        /* Org Doesn't Exist */
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'post',
            url: `/api/v1/orgs`,
            data: {
                username: req.grpSharedResourceId,
                full_name: req.displayName,
                description: `Code Repository for the ${req.displayName} team.  \nManaged by [**People Portal**](https://github.com/candiedoperation/AppDev-PeoplePortalServer).`,
                website: req.orgWebsite
            }
        }

        /* Throws an Exception! */
        await axios.request(RequestConfig)
        return true;
    }

    private async updateOrganization(req: GiteaOrgCreateRequest): Promise<boolean> {
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'patch',
            url: `/api/v1/orgs/${req.grpSharedResourceId}`,
            data: {
                full_name: req.displayName,
                description: `Code Repository for the ${req.displayName} team.  \nManaged by [**People Portal**](https://github.com/candiedoperation/AppDev-PeoplePortalServer).`,
                website: req.orgWebsite
            }
        }

        /* Throws an Exception! */
        await axios.request(RequestConfig)
        return true;
    }

    private async getTeamMembers(giteaTeamId: number): Promise<GiteaAPIUserDefinition[]> {
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'get',
            url: `/api/v1/teams/${giteaTeamId}/members`
        }

        const teamMembers = await axios.request(RequestConfig)
        return teamMembers.data
    }

    private async getTeamInfo(orgName: string, teamName: string): Promise<GiteaAPITeamDefinition> {
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'get',
            url: `/api/v1/orgs/${orgName}/teams/search?q=${teamName}`
        }

        const teamInfo = await axios.request(RequestConfig)
        const matchedTeams = teamInfo.data.data

        if (matchedTeams.length < 1)
            throw new GiteaClientResourceNotExists("Team Doesn't Exist")

        return matchedTeams[0]
    }

    private async getOrganizationInfo(orgName: string) {
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'get',
            url: `/api/v1/orgs/${orgName}`
        }

        try {
            const orgInfo = await axios.request(RequestConfig)
            return orgInfo.data
        } catch (e) {
            const error = e as AxiosError;
            if (error.response?.status == 404)
                throw new GiteaClientResourceNotExists("Organization Doesn't Exist")

            /* Throw the error, otherwise */
            throw e
        }
    }

    /* Repository Management */
    public async getRepository(owner: string, repo: string): Promise<GiteaRepository> {
        const response = await axios.request({
            ...this.GiteaBaseConfig,
            method: 'get',
            url: `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
        });

        return response.data as GiteaRepository;
    }

    public async deleteRepository(owner: string, repo: string) {
        var RequestConfig: any = {
            ...this.GiteaBaseConfig,
            method: 'delete',
            url: `/api/v1/repos/${owner}/${repo}`
        }

        try {
            /* Call the DELETE API */
            await axios.request(RequestConfig)
        } catch (e) {
            const error = e as AxiosError;
            if (error.response?.status == 404)
                throw new GiteaClientResourceNotExists("Repository Doesn't Exist")

            /* Throw the error, otherwise */
            throw e
        }
    }
}
