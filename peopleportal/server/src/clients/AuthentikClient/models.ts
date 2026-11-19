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

import { EnabledBindlePermissions } from "../../controllers/BindleController"
import { EnabledRootSettings, RootTeamSettingInfo } from "../../controllers/OrgController"

export enum TeamType {
    PROJECT = "PROJECT",
    CORPORATE = "CORPORATE",
    BOOTCAMP = "BOOTCAMP",
    SERVICE = "SERVICE"
}

export enum SeasonType {
    FALL = "FALL",
    SPRING = "SPRING"
}

export enum ServiceSeasonType {
    ROLLING = "ROLLING"
}

export interface TeamAttributeDefinition {
    friendlyName: string,
    teamType: TeamType,
    seasonType: SeasonType | ServiceSeasonType,
    seasonYear: number,
    teamStartDate?: string,
    teamEndDate?: string,
    peoplePortalCreation?: boolean,
    flaggedForDeletion?: boolean,
    /* ISO timestamp set when the team is archived; absent means active */
    archivedAt?: string,
    /* User PK of the executive who archived the team */
    archivedBy?: string,
    description: string,
    rootTeamSettings: {
        /* The key is the setting name (Ex. AwsAccount, AppleDevAccount, etc.) */
        [key: string]: EnabledRootSettings
    },

    bindlePermissions: {
        /* The key is the Client name (Ex. GiteaClient, OpenIdClient, etc.) */
        [key: string]: EnabledBindlePermissions
    }
}

export interface UserAttributeDefinition {
    peoplePortalCreation?: boolean,
    alumniAccount: boolean,
    major: string,
    expectedGrad: Date,
    phoneNumber: string,
    linkedinUrl?: string,
    roles: {
        /* Org ID Mapped to Role Title */
        [key: string]: string
    },
    avatar?: string
}

export interface AuthentikFilterCursor {
    authentikPage: number;
    authentikIndex: number;
    searchHash: string;
}


export interface PaginationDefinition {
    next: number;
    previous: number;
    count: number;
    current: number;
    total_pages: number;
    start_index: number;
    end_index: number;
}

/* Teams API Models */
export interface GetUserListOptions {
    page?: number,
    search?: string
}

export interface GetTeamsListOptions {
    subgroupsOnly?: boolean,
    includeUsers?: boolean,
    /* When false (default), teams flagged with `archivedAt` are excluded */
    includeArchived?: boolean,
    search?: string,
    limit?: number,
    cursor?: string
}

export interface GetTeamsForUsernameResponse {
    teams: TeamInformationBrief[]
}

/* Messy but, changing would cause breaking changes */
export interface TeamInformationBrief extends TeamAttributeDefinition {
    parent: string | null,
    name: string,
    pk: string,
}

/* Given in groups-list Authentik API endpoint */
export interface TeamInformationDetail extends TeamInformationBrief {
    users: UserInformationPartial[],
    parent_obj?: TeamInformationBrief,
    subteamPkList: string[],
    subteams: TeamInformationBrief[]
}

export interface TeamMembershipBrief extends TeamInformationBrief {
    parentName?: string,
    parentFriendlyName?: string,
}

export interface GetTeamMembershipsResponse {
    memberships: TeamMembershipBrief[]
}

export interface GetTeamsListResponse {
    teams: TeamInformationBrief[],
    nextCursor?: string
}

export interface GetTeamsListDetailResponse {
    teams: TeamInformationDetail[],
    nextCursor?: string
}

export interface GetGroupInfoRequestOptions {
    includeParentInfo?: boolean,
    includeChildren?: boolean,
    includeUsers?: boolean,
    disableSubteamMemberPopulate?: boolean
}

export interface GetGroupInfoResponse {
    pk: string,
    name: string,
    users: UserInformationBrief[],
    parentPk: string,
    parentInfo?: GetGroupInfoResponse, /* Optional to Avoid Breaking Changes */
    subteamPkList: string[],
    subteams: GetGroupInfoResponse[],
    attributes: TeamAttributeDefinition
}

export interface AddGroupMemberRequest {
    groupId: string,
    userPk: number,
    roleTitle: string
}

export interface RemoveGroupMemberRequest {
    groupInfo?: GetGroupInfoResponse, /* We Can Optimize Calls if using Bindle Auth */
    groupId: string,
    userPk: number
}

export interface CreateUserRequest {
    name: string;
    email: string;
    groupPk?: string;
    password: string;
    attributes: {
        major: string;
        expectedGrad: Date;
        phoneNumber: string;
        linkedinUrl?: string;
        roles: { [key: string]: string }
    }
}

export interface CreateTeamRequest {
    parent?: string,
    parentName?: string,
    isSuperuser?: boolean,
    serviceTeamName?: string,
    attributes: {
        friendlyName: string,
        teamType: TeamType,
        seasonType: SeasonType | ServiceSeasonType,
        seasonYear: number,
        description: string,
        /* Optional: only top-level teams carry meeting dates; sub-teams omit them */
        teamStartDate?: string,
        teamEndDate?: string,
    }
}

/* Returned in authentik groups-list API endpoint */
export interface UserInformationPartial {
    pk: string,
    username: string,
    name: string,
    email: string,
    active: boolean,
    attributes: UserAttributeDefinition,
}

/* User Information API Models */
export interface UserInformationBrief {
    pk: string,
    username: string,
    name: string,
    email: string,
    memberSince: Date,
    active: boolean,
    attributes: UserAttributeDefinition,
    is_superuser: boolean,
    avatar: string,
}

export interface UserInformationDetail extends UserInformationBrief {
    groups: string[],
    last_login: Date,
    type: string,
    groupsInfo: {
        name: string,
        pk: string,
        attributes: TeamAttributeDefinition
    }[],
}

export interface GetUserListResponse {
    pagination: PaginationDefinition,
    users: UserInformationBrief[]
}

export enum AuthentikClientErrorType {
    SERVER_VERSION_MISTMATCH = 100,
    SERVER_CONNECTION_ERROR = 101,
    MULTIPLE_RESULTS_RETURNED = 102,

    USERINFO_REQUEST_FAILED = 200,
    USERLIST_REQUEST_FAILED = 201,
    USERATTR_UPDATE_FAILED = 202,
    USER_NOT_FOUND = 203,
    USER_CREATE_FAILED = 204,

    GROUP_NOT_FOUND = 300,
    GROUPLIST_REQUEST_FAILED = 302,
    GROUPINFO_REQUEST_FAILED = 303,
    GROUPATTR_UPDATE_FAILED = 304,
    GROUP_ADD_MEMBER_FAILED = 305,
    GROUP_DEL_MEMBER_FAILED = 306,
    GROUP_SEASON_NOTPERMITTED = 307,
    GROUP_DUPLICATE_EXISTS = 308,
    GROUP_CREATE_FAILED = 309,
}

export class AuthentikClientError extends Error {
    constructor(public readonly code: AuthentikClientErrorType, messageOverride?: string) {
        super(messageOverride ?? AuthentikClientError.getMessage(code))
        this.name = "AuthentikClientError"
    }

    private static getMessage(code: AuthentikClientErrorType): string {
        switch (code) {
            case AuthentikClientErrorType.SERVER_VERSION_MISTMATCH:
                return "Authentik Server Version Mistmatch";
            case AuthentikClientErrorType.SERVER_CONNECTION_ERROR:
                return "Failed to validate Authentik Connection or Version.";
            case AuthentikClientErrorType.MULTIPLE_RESULTS_RETURNED:
                return "Mutiple Results with Same Name Returned!";

            case AuthentikClientErrorType.USERINFO_REQUEST_FAILED:
                return "Failed to fetch User Information.";
            case AuthentikClientErrorType.USERLIST_REQUEST_FAILED:
                return "Failed to fetch User List";
            case AuthentikClientErrorType.USERATTR_UPDATE_FAILED:
                return "Failed to update User Attributes";
            case AuthentikClientErrorType.USER_NOT_FOUND:
                return "User Not Found";
            case AuthentikClientErrorType.USER_CREATE_FAILED:
                return "Failed to Create User";

            case AuthentikClientErrorType.GROUPLIST_REQUEST_FAILED:
                return "Failed to fetch Group List for User";
            case AuthentikClientErrorType.GROUP_NOT_FOUND:
                return "Group Not Found";
            case AuthentikClientErrorType.GROUPINFO_REQUEST_FAILED:
                return "Failed to fetch Group Information";
            case AuthentikClientErrorType.GROUPATTR_UPDATE_FAILED:
                return "Failed to update Group Attributes";
            case AuthentikClientErrorType.GROUP_ADD_MEMBER_FAILED:
                return "Failed to Add Member to Group";
            case AuthentikClientErrorType.GROUP_DEL_MEMBER_FAILED:
                return "Failed to Remove Member from Group";
            case AuthentikClientErrorType.GROUP_SEASON_NOTPERMITTED:
                return "Season Not Permitted for Regular Teams";
            case AuthentikClientErrorType.GROUP_DUPLICATE_EXISTS:
                return "Team with the Same Name Already Exists!";
            case AuthentikClientErrorType.GROUP_CREATE_FAILED:
                return "Failed to Create Team";

            default:
                return "Unknown Error";
        }
    }
}

export class AuthentikServerVersion {
    private version: string;
    constructor(version: string) {
        this.version = version;
    }

    /**
     * Compares two Authentik Version Strings
     * 
     * @param v1 Authentik Version String
     * @param v2 Authentik Version String
     * @returns -1, 0 or 1 for numeric comparison
     */
    private static compare(v1: string, v2: string): number {
        const p1 = v1.split('.').map(Number);
        const p2 = v2.split('.').map(Number);
        const len = Math.max(p1.length, p2.length);

        for (let i = 0; i < len; i++) {
            const n1 = p1[i] || 0;
            const n2 = p2[i] || 0;
            if (n1 > n2) return 1;
            if (n1 < n2) return -1;
        }
        return 0;
    }

    public isAtLeast(other: string): boolean {
        return AuthentikServerVersion.compare(this.version, other) >= 0;
    }

    public isAtMost(other: string): boolean {
        return AuthentikServerVersion.compare(this.version, other) <= 0;
    }

    public toString(): string {
        return this.version;
    }
}
