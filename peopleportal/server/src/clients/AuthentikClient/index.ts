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

import axios from "axios"
import log from "loglevel"
import { AddGroupMemberRequest, AuthentikClientError, AuthentikServerVersion, CreateTeamRequest, CreateUserRequest, GetGroupInfoRequestOptions, GetGroupInfoResponse as GetGroupInfoResponse, GetTeamsListOptions as GetGroupsListOptions, GetTeamsListResponse as GetGroupsListResponse, GetTeamsForUsernameResponse, GetUserListOptions, GetUserListResponse, RemoveGroupMemberRequest, TeamAttributeDefinition, TeamInformationBrief, UserAttributeDefinition, UserInformationBrief, AuthentikFilterCursor, ServiceSeasonType, AuthentikClientErrorType, TeamType, UserInformationDetail, UserInformationPartial, TeamInformationDetail, GetTeamsListDetailResponse, TeamMembershipBrief, GetTeamMembershipsResponse } from "./models"
import { sanitizeGroupName } from "../../utils/strings"
import { EnabledRootSettings } from "../../controllers/OrgController"
import { BindleController, EnabledBindlePermissions } from "../../controllers/BindleController"
import { ENABLED_SERVICE_TEAMS } from "../../config"
import { ENABLED_SERVICE_TEAM_NAMES } from "../../utils/services"
import { mapWithConcurrency } from "../../utils/concurrency"

export class AuthentikClient {
    /* Authentik is a small self-hosted instance; a handful of parallel lookups
       hides the latency without turning a page load into a burst it has to
       queue. */
    private static readonly GROUP_FETCH_CONCURRENCY = 5;

    private static readonly TAG = "AuthentikClient"
    private AUTHENTIK_TOKEN = process.env.PEOPLEPORTAL_AUTHENTIK_TOKEN
    private readonly AxiosBaseConfig = {
        baseURL: process.env.PEOPLEPORTAL_AUTHENTIK_ENDPOINT ?? "",
        maxBodyLength: Infinity,
        headers: {
            'Accept': "application/json",
            'Authorization': `Bearer ${this.AUTHENTIK_TOKEN}`
        }
    }

    /* Server Version Compatibility */
    private static readonly MIN_SERVER_VERSION = "2025.12.0" /* Breaking Changes from 2025.8+ */
    private static readonly MAX_SERVER_VERSION = "2026.5.2"

    constructor() {
        if (!this.AxiosBaseConfig.baseURL)
            throw new Error("Authentik Backend URL is Invalid!")

        if (!this.AUTHENTIK_TOKEN)
            throw new Error("Authentik Token is Invalid!")
    }

    public static validateAuthentikConnection = async () => {
        const client = new AuthentikClient();
        var RequestConfig: any = {
            ...client.AxiosBaseConfig,
            method: 'get',
            url: `/api/v3/admin/version/`,
        }

        try {
            const res = await axios.request(RequestConfig)
            const version = new AuthentikServerVersion(res.data.version_current);
            if (!version.isAtLeast(AuthentikClient.MIN_SERVER_VERSION) || !version.isAtMost(AuthentikClient.MAX_SERVER_VERSION))
                throw new AuthentikClientError(
                    AuthentikClientErrorType.SERVER_VERSION_MISTMATCH,
                    `Authentik Server Version ${version} is not compatible with People Portal. Please ensure the server is greater than ${AuthentikClient.MIN_SERVER_VERSION} and less than ${AuthentikClient.MAX_SERVER_VERSION}`
                );

            /* Log Authentik Connection */
            log.info(AuthentikClient.TAG, `Connection Validated to Authentik v${version}`);
        } catch (e) {
            log.error(AuthentikClient.TAG, "Authentik Connection Validation Failed: ", e);
            throw new AuthentikClientError(AuthentikClientErrorType.SERVER_CONNECTION_ERROR);
        }
    }

    public validateServiceExistance = async () => {
        log.info(AuthentikClient.TAG, "Validating Service Teams");
        for (const rootTeamName in ENABLED_SERVICE_TEAMS) {
            let rootTeamPk = "";
            const rootTeamConfig = ENABLED_SERVICE_TEAMS[rootTeamName]!;

            /* 1. Ensure Root Team Exists */
            try {
                const rootServiceTeam = await this.createNewTeam({
                    serviceTeamName: rootTeamName,
                    attributes: {
                        friendlyName: rootTeamConfig.friendlyName,
                        teamType: TeamType.SERVICE,
                        seasonType: ServiceSeasonType.ROLLING,
                        seasonYear: new Date().getFullYear(),
                        description: rootTeamConfig.description,
                        teamStartDate: new Date().toISOString().slice(0, 10),
                        teamEndDate: new Date().toISOString().slice(0, 10),
                    }
                })

                /* Set Root Team PK */
                rootTeamPk = rootServiceTeam.pk;
            } catch (e) {
                /* If Duplicate Group Exists, Fetch the Existing Group */
                if (e instanceof AuthentikClientError && e.code == AuthentikClientErrorType.GROUP_DUPLICATE_EXISTS) {
                    try {
                        rootTeamPk = await this.getGroupPkFromName(rootTeamName);
                    } catch (fetchError) {
                        console.error(`Failed to fetch existing service team ${rootTeamName}`, fetchError);
                        continue;
                    }
                } else {
                    console.error(`Failed to create service team ${rootTeamName}`, e);
                    continue;
                }
            }

            /* 2. Process Subteams */
            for (const subTeam of rootTeamConfig.subteams) {
                let subTeamPk = "";

                try {
                    const createdSubTeam = await this.createNewTeam({
                        parent: rootTeamPk,
                        parentName: rootTeamName,
                        serviceTeamName: subTeam.uniqueName,
                        attributes: {
                            friendlyName: subTeam.friendlyName,
                            teamType: TeamType.CORPORATE,
                            seasonType: ServiceSeasonType.ROLLING,
                            seasonYear: new Date().getFullYear(),
                            description: subTeam.description,
                            teamStartDate: new Date().toISOString().slice(0, 10),
                            teamEndDate: new Date().toISOString().slice(0, 10),
                        }
                    })
                    subTeamPk = createdSubTeam.pk;
                } catch (e) {
                    if (e instanceof AuthentikClientError && e.code == AuthentikClientErrorType.GROUP_DUPLICATE_EXISTS) {
                        try {
                            subTeamPk = await this.getGroupPkFromName(subTeam.uniqueName);
                        } catch (fetchError) {
                            console.error(`Failed to fetch existing subteam ${subTeam.uniqueName}`, fetchError);
                            continue;
                        }
                    } else {
                        console.error(`Failed to create subteam ${subTeam.uniqueName}`, e);
                        continue;
                    }
                }

                /* 3. Apply Bindles */
                if (subTeam.bindles && subTeamPk) {
                    await this.updateBindlePermissions(
                        subTeamPk,
                        BindleController.sanitizeBindlePermissions(subTeam.bindles)
                    );
                }
            }
        }
    }

    public getUserInfo = async (userId: number): Promise<UserInformationDetail> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'get',
            url: `/api/v3/core/users/${userId}/`,
            params: {
                type: 'internal',
            }
        }

        try {
            const res = await axios.request(RequestConfig)
            return {
                pk: res.data.pk,
                username: res.data.username,
                name: res.data.name,
                email: res.data.email,
                memberSince: res.data.date_joined,
                active: res.data.is_active,
                attributes: res.data.attributes,
                is_superuser: res.data.is_superuser,
                last_login: res.data.last_login,
                groups: res.data.groups,
                type: res.data.type,
                groupsInfo: res.data.groups_obj,
                avatar: res.data.avatar,
            };
        } catch (e) {
            log.error(AuthentikClient.TAG, "User Info Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.USERINFO_REQUEST_FAILED)
        }
    }

    public getFullUserList = async (): Promise<{ users: UserInformationBrief[], failedPages: number[] }> => {
        const allUsers: UserInformationBrief[] = [];
        const failedPages: number[] = [];

        const firstPage = await this.getUserList({ page: 1 });

        if (firstPage.pagination.total_pages <= 1) {
            return { users: firstPage.users, failedPages: [] };
        }

        allUsers.push(...firstPage.users);
        const totalPages = firstPage.pagination.total_pages;
        const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);


        const results = await Promise.allSettled(
            remainingPages.map(p => this.getUserList({ page: p }))
        );

        for (const [idx, result] of results.entries()) {
            const page = remainingPages[idx]!;
            if (result.status === "fulfilled") {
                allUsers.push(...result.value.users);
            } else {
                log.error(AuthentikClient.TAG, `Failed to fetch page ${page}:`, result.reason);
                failedPages.push(page);
            }
        }

        return { users: allUsers, failedPages };
    }

    public getUserList = async (options: GetUserListOptions): Promise<GetUserListResponse> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'get',
            url: '/api/v3/core/users/',
            params: {
                /* Pick Only People Portal Created Users */
                path: 'peopleportal.atheesh.org/onboardeduser'
            }
        }
        console.log(RequestConfig);

        /* Append Optional Parameters */
        if (options?.page)
            RequestConfig.params.page = options.page

        if (options?.search)
            RequestConfig.params.search = options.search

        try {
            const res = await axios.request(RequestConfig)
            const userListArray: UserInformationBrief[] = res.data.results.map((user: any) => ({
                pk: user.pk,
                username: user.username,
                name: user.name,
                email: user.email,
                memberSince: user.date_joined,
                active: user.is_active,
                attributes: user.attributes,
            }))

            /* Return Mapped List */
            return {
                pagination: res.data.pagination,
                users: userListArray
            };
        } catch (e) {
            log.error(AuthentikClient.TAG, "Get User List Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.USERLIST_REQUEST_FAILED)
        }
    }

    public getRootTeamsForUsername = async (username: string): Promise<GetTeamsForUsernameResponse> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'get',
            url: '/api/v3/core/groups/',
            params: {
                include_users: false,
                is_superuser: false,
                include_parents: true, /* For Subteams, We return the Parent Team */
                include_children: false, /* We don't need subteams */
                members_by_username: username, /* Fetch Groups with Username as Member */
                page_size: 1000,
            }
        }

        try {
            const res = await axios.request(RequestConfig)
            const teamMap = new Map<string, TeamInformationBrief>();

            for (const group of res.data.results) {
                /* Filter by People Portal Creation */
                if (!group.attributes?.peoplePortalCreation)
                    continue;

                const parentPk = group.parents?.[0] ?? null;

                if (parentPk) {
                    /* It's a Subteam, so we append the Parent Team */
                    const parentTeam = group.parents_obj?.[0];

                    /* Safety Check */
                    if (!parentTeam) continue;

                    /* Skip Archived Root Teams */
                    if (parentTeam.attributes?.archivedAt) continue;

                    /* Add Parent to Map (Deduplicates) */
                    teamMap.set(parentTeam.pk, {
                        name: parentTeam.name,
                        pk: parentTeam.pk,
                        parent: null, /* Parent of a Parent is null (Root Team) */
                        ...parentTeam.attributes
                    });
                } else {
                    /* Skip Archived Root Teams */
                    if (group.attributes?.archivedAt) continue;

                    /* It's a Root Team */
                    teamMap.set(group.pk, {
                        name: group.name,
                        pk: group.pk,
                        parent: null,
                        ...group.attributes
                    });
                }
            }

            return {
                teams: Array.from(teamMap.values())
            };
        } catch (e) {
            log.error(AuthentikClient.TAG, "Get Group List for User Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUPLIST_REQUEST_FAILED)
        }
    }

    public getTeamMembershipsForUsername = async (username: string): Promise<GetTeamMembershipsResponse> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'get',
            url: '/api/v3/core/groups/',
            params: {
                include_users: false,
                is_superuser: false,
                include_parents: true, /* For Subteams, We return the Parent Team */
                include_children: false, /* We don't need subteams */
                members_by_username: username, /* Fetch Groups with Username as Member */
                page_size: 1000,
            }
        }

        try {
            const res = await axios.request(RequestConfig)
            const map = new Map<string, TeamMembershipBrief>();

            for (const group of res.data.results) {
                /* Filter by People Portal Creation */
                if (!group.attributes?.peoplePortalCreation)
                    continue;

                const parent = group.parents_obj?.[0] ?? null;
                map.set(group.pk, {                 // key = the membership group pk (matches roles keys)
                    name: group.name,
                    pk: group.pk,
                    parent: parent?.pk ?? null,
                    ...group.attributes,            // friendlyName, teamType, etc. of the SUBTEAM
                    parentName: parent?.name,
                    parentFriendlyName: parent?.attributes?.friendlyName,
                });
            }

            return { memberships: Array.from(map.values()) };
        } catch (e) {
            log.error(AuthentikClient.TAG, "Get Group List for User Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUPLIST_REQUEST_FAILED)
        }
    }

    /**
     * Fetches list of groups from Authentik and filters for People Portal Creations,
     * filters out subteams and returns only root level groups. Method provides infinite
     * scrolling support via Base64 encoded cursor pagination.
     * 
     * @param options Get Groups Options
     * @returns List of Groups
     */
    public getGroupsList = async (options: GetGroupsListOptions): Promise<GetGroupsListResponse> => {
        /* Default Limits */
        const limit = options.limit ?? 20;

        /* Initial Cursor State */
        let currentCursor: AuthentikFilterCursor = {
            authentikPage: 1,
            authentikIndex: 0,
            searchHash: Buffer.from(options.search ?? "").toString('base64')
        };

        /* Decode Cursor if provided */
        if (options.cursor) {
            try {
                const decoded = JSON.parse(Buffer.from(options.cursor, 'base64').toString('ascii'));

                /* Check Search Hash Consistency */
                const currentSearchHash = Buffer.from(options.search ?? "").toString('base64');
                if (decoded.searchHash === currentSearchHash) {
                    currentCursor = decoded;
                }
            } catch (e) {
                log.warn(AuthentikClient.TAG, "Invalid Cursor Provided, resetting to start.");
            }
        }

        const collectedTeams: TeamInformationBrief[] = [];
        let hasMorePages = true;

        try {
            while (collectedTeams.length < limit && hasMorePages) {
                var RequestConfig: any = {
                    ...this.AxiosBaseConfig,
                    method: 'get',
                    url: '/api/v3/core/groups/',
                    params: {
                        include_users: false,
                        is_superuser: false,
                        page: currentCursor.authentikPage,
                        page_size: 100, /* Fetch larger chunks internally */
                        ordering: 'name', /* Standard Order for Streaming */
                    }
                }

                if (options.includeUsers)
                    RequestConfig.params.include_users = options.includeUsers

                if (options.search)
                    RequestConfig.params.search = options.search

                const res = await axios.request(RequestConfig);
                const results = res.data.results;
                const totalPages = Math.ceil(res.data.pagination.count / 100);

                /* Iterate current page starting from cursor index */
                for (let i = currentCursor.authentikIndex; i < results.length; i++) {
                    const entry = results[i];

                    /* Filter Logic */
                    const parentPk = entry.parent ?? entry.parents?.[0] ?? null;  /* 01-19-2026 (@atheesh): Filtering Patches to support Authentik v2025.12+ */
                    const notArchived = options.includeArchived || !entry.attributes.archivedAt;
                    const isMatch = entry.attributes.peoplePortalCreation && notArchived && ((options.subgroupsOnly) ? parentPk : !parentPk);

                    if (isMatch) {
                        collectedTeams.push({
                            name: entry.name,
                            pk: entry.pk,
                            parent: parentPk,
                            ...entry.attributes
                        });
                    }

                    /* Advance Cursor Index */
                    currentCursor.authentikIndex = i + 1;

                    /* If limit reached, break loop */
                    if (collectedTeams.length >= limit) {
                        break;
                    }
                }

                /* Check if we need to advance to next page */
                if (collectedTeams.length < limit) {
                    if (currentCursor.authentikPage < totalPages) {
                        currentCursor.authentikPage++;
                        currentCursor.authentikIndex = 0; /* Reset index for new page */
                    } else {
                        hasMorePages = false; /* EOF */
                    }
                }
            }

            /* Construct Next Cursor */
            let nextCursor: string | undefined = undefined;
            if (hasMorePages) {
                nextCursor = Buffer.from(JSON.stringify(currentCursor)).toString('base64');
            }

            return {
                teams: collectedTeams,
                ...(nextCursor && { nextCursor })
            };

        } catch (e) {
            log.error(AuthentikClient.TAG, "Get Teams List Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUPLIST_REQUEST_FAILED)
        }
    }

    /**
     * Fetches list of groups from Authentik and filters for People Portal Creations,
     * filters out subteams and returns only root level groups. Method provides infinite
     * scrolling support via Base64 encoded cursor pagination. Returns detailed team
     * information rather than brief team information, allowing for avoidance of redundant
     * API calls.
     * 
     * @param options Get Groups Options
     * @returns List of Groups
     */
    public getGroupsListDetail = async (options: GetGroupsListOptions): Promise<GetTeamsListDetailResponse> => {
        /* Default Limits */
        const limit = options.limit ?? 20;

        /* Initial Cursor State */
        let currentCursor: AuthentikFilterCursor = {
            authentikPage: 1,
            authentikIndex: 0,
            searchHash: Buffer.from(options.search ?? "").toString('base64')
        };

        /* Decode Cursor if provided */
        if (options.cursor) {
            try {
                const decoded = JSON.parse(Buffer.from(options.cursor, 'base64').toString('ascii'));

                /* Check Search Hash Consistency */
                const currentSearchHash = Buffer.from(options.search ?? "").toString('base64');
                if (decoded.searchHash === currentSearchHash) {
                    currentCursor = decoded;
                }
            } catch (e) {
                log.warn(AuthentikClient.TAG, "Invalid Cursor Provided, resetting to start.");
            }
        }

        const collectedTeams: TeamInformationDetail[] = [];
        let hasMorePages = true;

        try {
            while (collectedTeams.length < limit && hasMorePages) {
                var RequestConfig: any = {
                    ...this.AxiosBaseConfig,
                    method: 'get',
                    url: '/api/v3/core/groups/',
                    params: {
                        include_users: true,
                        include_children: true,
                        is_superuser: false,
                        page: currentCursor.authentikPage,
                        page_size: 100, /* Fetch larger chunks internally */
                        ordering: 'name', /* Standard Order for Streaming */
                    }
                }

                if (options.includeUsers)
                    RequestConfig.params.include_users = options.includeUsers

                if (options.search)
                    RequestConfig.params.search = options.search

                const res = await axios.request(RequestConfig);
                const results = res.data.results;
                const totalPages = Math.ceil(res.data.pagination.count / 100);

                /* Iterate current page starting from cursor index */
                for (let i = currentCursor.authentikIndex; i < results.length; i++) {
                    const entry = results[i];

                    /* Filter Logic */
                    const parentPk = entry.parent ?? entry.parents?.[0] ?? null;  /* 01-19-2026 (@atheesh): Filtering Patches to support Authentik v2025.12+ */
                    /* Archived teams are excluded unless asked for, matching
                       getGroupsList. Without this the org chart, the only caller,
                       kept drawing teams that had been archived: archiveTeam
                       stamps attributes.archivedAt and tears down the team's
                       Slack, Gitea and AWS resources, but nothing removed the
                       group, so it still arrived here. */
                    const notArchived = options.includeArchived || !entry.attributes.archivedAt;
                    const isMatch = notArchived && entry.attributes.peoplePortalCreation && ((options.subgroupsOnly) ? parentPk : !parentPk);

                    let parent_obj: TeamInformationBrief | undefined = undefined;
                    if (parentPk !== null && entry.parent_obj != null) {
                        for (const parent of entry.parents_obj) {
                            if (parent.pk === parentPk) {
                                parent_obj = parent;
                                break;
                            }
                        }
                    }
                    
                    let users: UserInformationPartial[] = [];
                    if (entry.users_obj != null) {
                        users = entry.users_obj.map((user_obj: { 
                            pk: number, username: string, name: string, is_active: boolean, 
                            last_login: Date, email: string, attributes: UserAttributeDefinition, uid: string 
                        }) => {
                            return {
                                pk: user_obj.pk,
                                username: user_obj.username,
                                name: user_obj.name,
                                email: user_obj.email,
                                active: user_obj.is_active,
                                attributes: user_obj.attributes,
                            };
                        });
                    }
                    
                    let subteams: TeamInformationBrief[] = [];
                    if (entry.children_obj != null) {
                        subteams = entry.children_obj.map((subteam: {
                            pk: string, name: string, is_superuser: boolean, attributes: TeamAttributeDefinition, group_uuid: string,
                        }) => {
                            return {
                                pk: subteam.pk,
                                name: subteam.name,
                                parent: entry.pk,
                                ...subteam.attributes
                            };
                        });
                    }

                    if (isMatch) {
                        collectedTeams.push({
                            pk: entry.pk,
                            name: entry.name,
                            users: users,
                            parentPk: parentPk,
                            parentInfo: parent_obj,
                            subteamPkList: entry.children,
                            subteams: subteams,
                            ...entry.attributes
                        });
                    }

                    /* Advance Cursor Index */
                    currentCursor.authentikIndex = i + 1;

                    /* If limit reached, break loop */
                    if (collectedTeams.length >= limit) {
                        break;
                    }
                }

                /* Check if we need to advance to next page */
                if (collectedTeams.length < limit) {
                    if (currentCursor.authentikPage < totalPages) {
                        currentCursor.authentikPage++;
                        currentCursor.authentikIndex = 0; /* Reset index for new page */
                    } else {
                        hasMorePages = false; /* EOF */
                    }
                }
            }

            /* Construct Next Cursor */
            let nextCursor: string | undefined = undefined;
            if (hasMorePages) {
                nextCursor = Buffer.from(JSON.stringify(currentCursor)).toString('base64');
            }

            return {
                teams: collectedTeams,
                ...(nextCursor && { nextCursor })
            };

        } catch (e) {
            log.error(AuthentikClient.TAG, "Get Teams List Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUPLIST_REQUEST_FAILED)
        }
    }

    public getGroupPkFromName = async (teamName: string): Promise<string> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'get',
            url: `/api/v3/core/groups/`,
            params: {
                include_users: false,
                include_children: false,
                name: teamName
            }
        }

        try {
            const res = await axios.request(RequestConfig)
            const teams = res.data.results

            /* Filter for Exact Match */
            const exactMatches = teams.filter((t: any) => t.name === teamName)

            if (exactMatches.length < 1)
                throw new AuthentikClientError(AuthentikClientErrorType.GROUP_NOT_FOUND)

            if (exactMatches.length > 1)
                throw new AuthentikClientError(AuthentikClientErrorType.MULTIPLE_RESULTS_RETURNED)

            const team = exactMatches[0]
            return team.pk
        } catch (e) {
            throw e
        }
    }

    /**
     * Resolves many groups in one request instead of one request per group.
     *
     * The open-roles endpoint used to call getGroupInfo in a sequential loop,
     * so its latency scaled with the number of recruiting teams: at 13 teams
     * that is 13 serial round trips before a single byte is returned, and with
     * subteam member population on top it was closer to 65.
     *
     * Authentik's list endpoint returns the same shape as the detail endpoint,
     * so one paginated sweep answers all of them. Any pk the sweep does not
     * cover falls back to an individual fetch, bounded in parallel: that keeps
     * this correct if the list endpoint ever filters differently, and it is
     * also what surfaces a real GROUP_NOT_FOUND for a group that is genuinely
     * gone, which callers rely on to clean up their own rows.
     */
    public getGroupsInfoByPks = async (
        pks: readonly string[],
        options?: GetGroupInfoRequestOptions
    ): Promise<Map<string, GetGroupInfoResponse>> => {
        const resolved = new Map<string, GetGroupInfoResponse>();
        const wanted = new Set(pks);
        if (wanted.size === 0) return resolved;

        const includeUsers = options?.includeUsers ?? false;
        const toGroupInfo = (entry: any): GetGroupInfoResponse => ({
            pk: entry.pk,
            name: entry.name,
            subteamPkList: entry.children,
            subteams: entry.children_obj ?? [],
            parentPk: entry.parent ?? entry.parents?.[0] ?? null,
            parentInfo: entry.parents_obj ? entry.parents_obj[0] : null,
            attributes: entry.attributes,
            users: (entry.users_obj ?? []).map((user: any) => ({
                pk: user.pk,
                username: user.username,
                name: user.name,
                email: user.email,
                attributes: user.attributes
            }))
        });

        /* One sweep of the directory. Authentik has no pk__in filter, so the
           set is narrowed locally; a club-sized directory is a page or two. */
        try {
            let page = 1;
            let totalPages = 1;

            while (page <= totalPages && resolved.size < wanted.size) {
                const res = await axios.request({
                    ...this.AxiosBaseConfig,
                    method: 'get',
                    url: '/api/v3/core/groups/',
                    params: {
                        include_users: includeUsers,
                        include_children: options?.includeChildren ?? true,
                        include_parents: options?.includeParentInfo ?? false,
                        page,
                        page_size: 1000
                    }
                });

                for (const entry of res.data.results ?? []) {
                    if (wanted.has(entry.pk)) resolved.set(entry.pk, toGroupInfo(entry));
                }

                totalPages = res.data.pagination?.total_pages ?? 1;
                page++;
            }
        } catch (e) {
            /* A failed sweep is not fatal; every pk simply falls through to the
               per-group path below, which is the old behaviour. */
            log.warn(AuthentikClient.TAG, "Bulk group fetch failed, falling back to individual lookups: ", e)
        }

        const missing = [...wanted].filter((pk) => !resolved.has(pk));
        if (missing.length === 0) return resolved;

        const settled = await mapWithConcurrency(
            missing,
            AuthentikClient.GROUP_FETCH_CONCURRENCY,
            (pk) => this.getGroupInfo(pk, options)
        );

        for (const [i, result] of settled.entries()) {
            if (result.status === "fulfilled") {
                resolved.set(missing[i]!, result.value);
                continue;
            }

            /* GROUP_NOT_FOUND is meaningful to callers and must not be
               flattened into "missing from the map" alongside a network
               failure, so it is rethrown. */
            if (result.reason instanceof AuthentikClientError &&
                result.reason.code === AuthentikClientErrorType.GROUP_NOT_FOUND)
                continue;

            throw result.reason;
        }

        return resolved;
    }

    public getGroupInfo = async (teamId: string, options?: GetGroupInfoRequestOptions): Promise<GetGroupInfoResponse> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'get',
            url: `/api/v3/core/groups/${teamId}/`,
            params: {
                /* Avoid Breaking Changes of Including Request Options, Default to True */
                include_users: options?.includeUsers ?? true,
                include_children: options?.includeChildren ?? true,
                include_parents: options?.includeParentInfo ?? false
            }
        }

        try {
            const res = await axios.request(RequestConfig)
            const subteams = res.data.children_obj

            /* Populate Users Within Subteams, Optional to Avoid Breaking Changes */
            if (!(options?.disableSubteamMemberPopulate)) {
                for (let subteam of subteams) {
                    const subteamInfo = await this.getGroupInfo(subteam.pk)
                    subteam.users = subteamInfo.users
                }
            }

            return {
                pk: res.data.pk,
                name: res.data.name,
                subteamPkList: res.data.children,
                subteams: res.data.children_obj,
                parentPk: res.data.parent ?? res.data.parents?.[0] ?? null, /* People Portal Legacy Single Parent Patch */
                parentInfo: res.data.parents_obj ? res.data.parents_obj[0] : null, /* Authentik 2025.12+ Only */
                attributes: res.data.attributes,
                users: (res.data.users_obj ?? []).map((user: any) => ({
                    pk: user.pk,
                    username: user.username,
                    name: user.name,
                    email: user.email,
                    attributes: user.attributes
                }))
            }
        } catch (e) {
            /* Log The Error */
            log.error(AuthentikClient.TAG, "Get Teams List Request Failed with Error: ", e)

            /* 02-06-2026 (@atheesh): Data Integrity Compromise, See COE at https://wiki.appdevclub.com/people-portal-dev-guide/coe/ats-open-roles-failure */
            if (axios.isAxiosError(e) && e.response?.status === 404 && e.response?.headers['x-powered-by'] === 'authentik')
                throw new AuthentikClientError(AuthentikClientErrorType.GROUP_NOT_FOUND)

            /* We Just Know that the Request Failed! */
            throw new AuthentikClientError(AuthentikClientErrorType.GROUPINFO_REQUEST_FAILED)
        }
    }

    /**
     * Private method to update any group attributes. 
     * Warning: Shouldn't be made public and inputs need to be sanitized as it
     * executes directly on the Authentik Backend!
     * 
     * @param teamId Target Team ID
     * @param updatePayload Raw, Sanitized Update Payload
     * @returns True if the update was successful
     */
    private updateGroupAttributes = async (teamId: string, updatePayload: Partial<TeamAttributeDefinition>): Promise<boolean> => {
        let groupInfo = await this.getGroupInfo(teamId);
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'patch',
            url: `/api/v3/core/groups/${teamId}/`,
            data: {
                attributes: {
                    ...groupInfo.attributes,
                    ...updatePayload
                }
            }
        }

        try {
            await axios.request(RequestConfig)
            return true
        } catch (e) {
            log.error(AuthentikClient.TAG, "Update Group Attributes Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUPATTR_UPDATE_FAILED)
        }
    }

    /**
     * Method to sanitize and update the Root Team Settings.
     * Internally calls updateGroupAttributes.
     * 
     * @param teamId Target Team ID
     * @param teamSettings Unsanitized Root Team Settings
     * @returns True if update was successful
     */
    public updateRootTeamSettings = async (teamId: string, teamSettings: { [key: string]: EnabledRootSettings }): Promise<boolean> => {
        return await this.updateGroupAttributes(
            teamId,
            { rootTeamSettings: teamSettings }
        )
    }

    /**
     * Method to Update Team Bindle Permissions.
     * Internally calls updateGroupAttributes.
     * 
     * @param teamId Target Team ID
     * @param bindlePermissions Unsanitized Bindle Perissions Map
     * @returns True if update was successful
     */
    public updateBindlePermissions = async (teamId: string, bindlePermissions: { [key: string]: EnabledBindlePermissions }): Promise<boolean> => {
        return await this.updateGroupAttributes(
            teamId,
            { bindlePermissions }
        )
    }

    /**
     * Flags a group for deletion.
     * Internally calls updateGroupAttributes.
     * 
     * @param teamId Target Team ID
     * @returns True if update was successful
     */
    public flagGroupForDeletion = async (teamId: string): Promise<boolean> => {
        return await this.updateGroupAttributes(
            teamId,
            { flaggedForDeletion: true }
        )
    }

    /**
     * Marks a group as archived by stamping an `archivedAt` timestamp (and
     * optionally the archiving executive). Internally calls updateGroupAttributes.
     *
     * @param teamId Target Team ID
     * @param archivedBy Optional User PK of the executive performing the archive
     * @returns True if update was successful
     */
    public archiveGroup = async (teamId: string, archivedBy?: string): Promise<boolean> => {
        return await this.updateGroupAttributes(
            teamId,
            {
                archivedAt: new Date().toISOString(),
                ...(archivedBy !== undefined && { archivedBy })
            }
        )
    }

    /**
     * Validates and updates group information (Friendly Name, Description, Team Dates).
     * 
     * @param teamId Target Team ID
     * @param conf Configuration object containing potential updates
     */
    public updateGroupInformation = async (teamId: string, conf: { [key: string]: string | undefined }) => {
        /* Strictly restrict updates to allowed fields to prevent attribute pollution */
        const allowedFields = ["friendlyName", "description", "teamStartDate", "teamEndDate"];
        const filteredConf: any = {};

        for (const key of allowedFields) {
            if (conf[key] !== undefined) {
                if (conf[key]!.trim() === "") {
                    throw new Error("Attributes cannot be blank");
                }
                filteredConf[key] = conf[key];
            }
        }

        if (Object.keys(filteredConf).length === 0) {
            throw new Error("No valid fields provided for update");
        }

        await this.updateGroupAttributes(teamId, filteredConf);
    }

    /**
     * Method to update User Attibutes in the Authentik Backend.
     * Requires verified update payload of type Partial<UserAttributeDefinition>
     * 
     * @param userId Target User ID
     * @param updatePayload Verified Update Payload
     * @returns True if update was successful
     */
    public updateUserAttributes = async (userId: number, updatePayload: Partial<UserAttributeDefinition>): Promise<boolean> => {
        let userInfo = await this.getUserInfo(userId);
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'patch',
            url: `/api/v3/core/users/${userId}/`,
            data: {
                attributes: {
                    ...userInfo.attributes,
                    ...updatePayload
                }
            }
        }

        try {
            await axios.request(RequestConfig)
            return true
        } catch (e) {
            log.error(AuthentikClient.TAG, "Update User Attributes Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.USERATTR_UPDATE_FAILED)
        }
    }

    public addGroupMember = async (request: AddGroupMemberRequest): Promise<boolean> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'post',
            url: `/api/v3/core/groups/${request.groupId}/add_user/`,
            data: { pk: request.userPk }
        }

        try {
            await axios.request(RequestConfig)
            return true
        } catch (e) {
            log.error(AuthentikClient.TAG, "Add Team Member Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUP_ADD_MEMBER_FAILED)
        }
    }

    public removeGroupMember = async (request: RemoveGroupMemberRequest): Promise<boolean> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'post',
            url: `/api/v3/core/groups/${request.groupId}/remove_user/`,
            data: { pk: request.userPk }
        }

        try {
            await axios.request(RequestConfig)
            return true
        } catch (e) {
            log.error(AuthentikClient.TAG, "Remove Team Member Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUP_DEL_MEMBER_FAILED)
        }
    }

    public removeAllTeamMembers = async (groupId: string): Promise<boolean> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'patch',
            url: `/api/v3/core/groups/${groupId}/`,
            data: { users: [] }
        }

        try {
            await axios.request(RequestConfig)
            return true
        } catch (e) {
            log.error(AuthentikClient.TAG, "Remove All Team Members Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUP_DEL_MEMBER_FAILED)
        }
    }

    public getUserInfoFromEmail = async (email: string): Promise<UserInformationBrief> => {
        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'get',
            url: `/api/v3/core/users/`,
            params: {
                email,
                type: 'internal',
            }
        }

        try {
            const res = await axios.request(RequestConfig)
            const users = res.data.results

            /* Filter for Exact Match */
            const exactMatches = users.filter((u: any) => u.email === email)

            if (exactMatches.length < 1)
                throw new AuthentikClientError(AuthentikClientErrorType.USER_NOT_FOUND)

            if (exactMatches.length > 1)
                throw new AuthentikClientError(AuthentikClientErrorType.MULTIPLE_RESULTS_RETURNED)

            const user = exactMatches[0]
            return {
                pk: user.pk,
                username: user.username,
                name: user.name,
                email: user.email,
                memberSince: user.date_joined,
                active: user.is_active,
                attributes: user.attributes,
                is_superuser: user.is_superuser,
                avatar: user.avatar,
            }
        } catch (e) {
            log.error(AuthentikClient.TAG, "Get User PK Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.USERINFO_REQUEST_FAILED)
        }
    }

    public createNewUser = async (request: CreateUserRequest): Promise<boolean> => {
        if (!request.email.endsWith("@terpmail.umd.edu"))
            throw new Error("People Portal Currently Supports Terpmail Addresses Only!")

        let username = request.email.replace("@terpmail.umd.edu", "")
        var RequestConfigAddUser: any = {
            ...this.AxiosBaseConfig,
            method: 'post',
            url: '/api/v3/core/users/',
            data: {
                username,
                name: request.name,
                groups: request.groupPk ? [request.groupPk] : [],
                email: request.email,
                path: "peopleportal.atheesh.org/onboardeduser",
                attributes: {
                    ...request.attributes,
                    peoplePortalCreation: true,
                }
            }
        }

        try {
            const res = await axios.request(RequestConfigAddUser)
            const userPk = res.data.pk

            /* Set User Password */
            var RequestConfigSetPassword: any = {
                ...this.AxiosBaseConfig,
                method: 'post',
                url: `/api/v3/core/users/${userPk}/set_password/`,
                data: {
                    password: request.password
                }
            }

            await axios.request(RequestConfigSetPassword)
            return true
        } catch (e) {
            log.error(AuthentikClient.TAG, "Create New User Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.USER_CREATE_FAILED)
        }
    }

    /**
     * Creates a New Team in the Authentik database and sets default People Portal
     * creation attributes.
     * 
     * This method supports providing a parent to assist in the creation of subteams
     * within an existing team.
     * 
     * Additionally, this method supports creating service teams using the Service Team Name
     * parameter to create a service team with the specified name.
     * 
     * @param request Create Team Request
     * @returns Newly Created Team
     */
    public createNewTeam = async (request: CreateTeamRequest): Promise<GetGroupInfoResponse> => {
        if (request.parent && !request.parentName)
            throw new Error("Creating a SubTeam needs a Parent Name!")

        /* Validation: Service Season Types are restricted to Service Teams */
        if (!request.serviceTeamName && (Object.values(ServiceSeasonType) as string[]).includes(request.attributes.seasonType)) {
            throw new AuthentikClientError(AuthentikClientErrorType.GROUP_SEASON_NOTPERMITTED);
        }

        const attr = request.attributes
        const teamName = request.serviceTeamName ?
            request.serviceTeamName :
            sanitizeGroupName(`${attr.friendlyName.replaceAll(" ", "")}${attr.seasonType}${attr.seasonYear}`)

        /* Validation: Ensure Regular Teams do not use Service Team Names */
        if (!request.serviceTeamName) {
            for (const reservedName of ENABLED_SERVICE_TEAM_NAMES) {
                if (teamName.toLowerCase().includes(reservedName.toLowerCase())) {
                    throw new AuthentikClientError(AuthentikClientErrorType.GROUP_DUPLICATE_EXISTS);
                }
            }
        }

        /* Define Default Attributes */
        const teamAttributes: TeamAttributeDefinition = {
            ...request.attributes,
            peoplePortalCreation: true,  /* Helps Identify People Portal Managed Entires! */
            rootTeamSettings: {},
            bindlePermissions: {},
        }

        /* Check if a team with the Same Name Exists! */
        let teamExists = false
        try {
            const teamPk = await this.getGroupPkFromName(teamName)
            teamExists = true
        } catch (e) {
            /* If its some other error than count, throw it! */
            if (!(e instanceof AuthentikClientError))
                throw e
        }

        if (teamExists)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUP_DUPLICATE_EXISTS)

        var RequestConfig: any = {
            ...this.AxiosBaseConfig,
            method: 'post',
            url: '/api/v3/core/groups/',
            data: {
                is_superuser: false,
                name: (request.parent && !request.serviceTeamName) ? `${sanitizeGroupName(request.parentName!)}${teamName}` : teamName,
                parents: request.parent ? [request.parent] : [], /* Patched for Authentik v2025.12+ */
                attributes: teamAttributes
            }
        }

        try {
            const res = await axios.request(RequestConfig)
            return {
                pk: res.data.pk,
                name: res.data.name,
                subteamPkList: res.data.children,
                subteams: res.data.children_obj,
                parentPk: res.data.parent ?? res.data.parents?.[0] ?? null, /* People Portal Legacy Single Parent Patch */
                parentInfo: res.data.parents_obj ? res.data.parents_obj[0] : null, /* Authentik 2025.12+ Only */
                attributes: res.data.attributes,
                users: (res.data.users_obj ?? []).map((user: any) => ({
                    pk: user.pk,
                    username: user.username,
                    name: user.name,
                    email: user.email,
                    attributes: user.attributes
                }))
            }
        } catch (e) {
            log.error(AuthentikClient.TAG, "Create Team Request Failed with Error: ", e)
            throw new AuthentikClientError(AuthentikClientErrorType.GROUP_CREATE_FAILED)
        }
    }
}