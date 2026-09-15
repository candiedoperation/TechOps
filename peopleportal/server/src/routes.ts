/* tslint:disable */
/* eslint-disable */
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import type { TsoaRoute } from '@tsoa/runtime';
import {  fetchMiddlewares, ExpressTemplateService } from '@tsoa/runtime';
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import { OrgController } from './controllers/OrgController';
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import { BindleController } from './controllers/BindleController';
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import { ProjectCatalogController } from './controllers/ProjectCatalogController';
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import { PlatformController } from './controllers/PlatformController';
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import { MeetingsController } from './controllers/MeetingsController';
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import { HooksController } from './controllers/HooksController';
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import { EventController } from './controllers/EventController';
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import { AuthController } from './controllers/AuthController';
// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
import { ATSController } from './controllers/ATSController';
import { expressAuthentication } from './auth';
// @ts-ignore - no great way to install types from subpackage
import type { Request as ExRequest, Response as ExResponse, RequestHandler, Router } from 'express';

const expressAuthenticationRecasted = expressAuthentication as (req: ExRequest, securityName: string, scopes?: string[], res?: ExResponse) => Promise<any>;


// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

const models: TsoaRoute.Models = {
    "PaginationDefinition": {
        "dataType": "refObject",
        "properties": {
            "next": {"dataType":"double","required":true},
            "previous": {"dataType":"double","required":true},
            "count": {"dataType":"double","required":true},
            "current": {"dataType":"double","required":true},
            "total_pages": {"dataType":"double","required":true},
            "start_index": {"dataType":"double","required":true},
            "end_index": {"dataType":"double","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "UserAttributeDefinition": {
        "dataType": "refObject",
        "properties": {
            "peoplePortalCreation": {"dataType":"boolean"},
            "alumniAccount": {"dataType":"boolean","required":true},
            "major": {"dataType":"string","required":true},
            "expectedGrad": {"dataType":"datetime","required":true},
            "phoneNumber": {"dataType":"string","required":true},
            "linkedinUrl": {"dataType":"string"},
            "roles": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"dataType":"string"},"required":true},
            "avatar": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "UserInformationBrief": {
        "dataType": "refObject",
        "properties": {
            "pk": {"dataType":"string","required":true},
            "username": {"dataType":"string","required":true},
            "name": {"dataType":"string","required":true},
            "email": {"dataType":"string","required":true},
            "memberSince": {"dataType":"datetime","required":true},
            "active": {"dataType":"boolean","required":true},
            "attributes": {"ref":"UserAttributeDefinition","required":true},
            "is_superuser": {"dataType":"boolean","required":true},
            "avatar": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetUserListResponse": {
        "dataType": "refObject",
        "properties": {
            "pagination": {"ref":"PaginationDefinition","required":true},
            "users": {"dataType":"array","array":{"dataType":"refObject","ref":"UserInformationBrief"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetUserListOptions": {
        "dataType": "refObject",
        "properties": {
            "page": {"dataType":"double"},
            "search": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIUserInfoResponse": {
        "dataType": "refObject",
        "properties": {
            "pk": {"dataType":"string","required":true},
            "username": {"dataType":"string","required":true},
            "name": {"dataType":"string","required":true},
            "email": {"dataType":"string","required":true},
            "memberSince": {"dataType":"datetime","required":true},
            "active": {"dataType":"boolean","required":true},
            "attributes": {"ref":"UserAttributeDefinition","required":true},
            "is_superuser": {"dataType":"boolean","required":true},
            "avatar": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "TeamType": {
        "dataType": "refEnum",
        "enums": ["PROJECT","CORPORATE","BOOTCAMP","SERVICE"],
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "SeasonType": {
        "dataType": "refEnum",
        "enums": ["FALL","SPRING"],
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ServiceSeasonType": {
        "dataType": "refEnum",
        "enums": ["ROLLING"],
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "EnabledRootSettings": {
        "dataType": "refObject",
        "properties": {
        },
        "additionalProperties": {"dataType":"boolean"},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "EnabledBindlePermissions": {
        "dataType": "refObject",
        "properties": {
        },
        "additionalProperties": {"dataType":"boolean"},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "TeamInformationBrief": {
        "dataType": "refObject",
        "properties": {
            "friendlyName": {"dataType":"string","required":true},
            "teamType": {"ref":"TeamType","required":true},
            "seasonType": {"dataType":"union","subSchemas":[{"ref":"SeasonType"},{"ref":"ServiceSeasonType"}],"required":true},
            "seasonYear": {"dataType":"double","required":true},
            "teamStartDate": {"dataType":"string"},
            "teamEndDate": {"dataType":"string"},
            "peoplePortalCreation": {"dataType":"boolean"},
            "flaggedForDeletion": {"dataType":"boolean"},
            "archivedAt": {"dataType":"string"},
            "archivedBy": {"dataType":"string"},
            "description": {"dataType":"string","required":true},
            "rootTeamSettings": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"ref":"EnabledRootSettings"},"required":true},
            "bindlePermissions": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"ref":"EnabledBindlePermissions"},"required":true},
            "parent": {"dataType":"union","subSchemas":[{"dataType":"string"},{"dataType":"enum","enums":[null]}],"required":true},
            "name": {"dataType":"string","required":true},
            "pk": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIGetCommonTeamsResponse": {
        "dataType": "refObject",
        "properties": {
            "teams": {"dataType":"array","array":{"dataType":"refObject","ref":"TeamInformationBrief"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "mongoose.FlattenMaps_IUserReview_": {
        "dataType": "refAlias",
        "type": {"dataType":"nestedObjectLiteral","nestedProperties":{},"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "mongoose.Types.ObjectId": {
        "dataType": "refAlias",
        "type": {"dataType":"string","validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "Required___id-mongoose.Types.ObjectId__": {
        "dataType": "refAlias",
        "type": {"dataType":"nestedObjectLiteral","nestedProperties":{"_id":{"ref":"mongoose.Types.ObjectId","required":true}},"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "DocumentJSON_IUserReview_": {
        "dataType": "refAlias",
        "type": {"dataType":"intersection","subSchemas":[{"ref":"mongoose.FlattenMaps_IUserReview_"},{"ref":"Required___id-mongoose.Types.ObjectId__"},{"dataType":"nestedObjectLiteral","nestedProperties":{"__v":{"dataType":"double","required":true}}}],"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIGetReviewResponse": {
        "dataType": "refObject",
        "properties": {
            "review": {"dataType":"union","subSchemas":[{"ref":"DocumentJSON_IUserReview_"},{"dataType":"enum","enums":[null]}],"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIGetReviewsResponse": {
        "dataType": "refObject",
        "properties": {
            "reviews": {"dataType":"array","array":{"dataType":"refAlias","ref":"DocumentJSON_IUserReview_"},"required":true},
            "aggregateData": {"dataType":"nestedObjectLiteral","nestedProperties":{"averageRating":{"dataType":"double","required":true},"totalReviews":{"dataType":"double","required":true}}},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIGetReviewsOptions": {
        "dataType": "refObject",
        "properties": {
            "before": {"dataType":"datetime"},
            "after": {"dataType":"datetime"},
            "teamId": {"dataType":"datetime"},
            "sortBy": {"dataType":"union","subSchemas":[{"dataType":"enum","enums":["updatedAt"]},{"dataType":"enum","enums":["rating"]}]},
            "ascending": {"dataType":"boolean"},
            "offset": {"dataType":"double"},
            "limit": {"dataType":"double"},
            "getAggregateData": {"dataType":"boolean"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APICreateReviewResponse": {
        "dataType": "refObject",
        "properties": {
            "review": {"ref":"DocumentJSON_IUserReview_","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APICreateReviewRequest": {
        "dataType": "refObject",
        "properties": {
            "rating": {"dataType":"double","required":true},
            "title": {"dataType":"string","required":true},
            "content": {"dataType":"string","required":true},
            "teamId": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "Record_string.string_": {
        "dataType": "refAlias",
        "type": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"dataType":"string"},"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetTeamsForUsernameResponse": {
        "dataType": "refObject",
        "properties": {
            "teams": {"dataType":"array","array":{"dataType":"refObject","ref":"TeamInformationBrief"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "TeamMembershipBrief": {
        "dataType": "refObject",
        "properties": {
            "friendlyName": {"dataType":"string","required":true},
            "teamType": {"ref":"TeamType","required":true},
            "seasonType": {"dataType":"union","subSchemas":[{"ref":"SeasonType"},{"ref":"ServiceSeasonType"}],"required":true},
            "seasonYear": {"dataType":"double","required":true},
            "teamStartDate": {"dataType":"string"},
            "teamEndDate": {"dataType":"string"},
            "peoplePortalCreation": {"dataType":"boolean"},
            "flaggedForDeletion": {"dataType":"boolean"},
            "archivedAt": {"dataType":"string"},
            "archivedBy": {"dataType":"string"},
            "description": {"dataType":"string","required":true},
            "rootTeamSettings": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"ref":"EnabledRootSettings"},"required":true},
            "bindlePermissions": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"ref":"EnabledBindlePermissions"},"required":true},
            "parent": {"dataType":"union","subSchemas":[{"dataType":"string"},{"dataType":"enum","enums":[null]}],"required":true},
            "name": {"dataType":"string","required":true},
            "pk": {"dataType":"string","required":true},
            "parentName": {"dataType":"string"},
            "parentFriendlyName": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetTeamMembershipsResponse": {
        "dataType": "refObject",
        "properties": {
            "memberships": {"dataType":"array","array":{"dataType":"refObject","ref":"TeamMembershipBrief"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "RootTeamSettingInfo": {
        "dataType": "refObject",
        "properties": {
            "friendlyName": {"dataType":"string","required":true},
            "description": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "RootTeamSettingMap": {
        "dataType": "refObject",
        "properties": {
        },
        "additionalProperties": {"ref":"RootTeamSettingInfo"},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetTeamsListResponse": {
        "dataType": "refObject",
        "properties": {
            "teams": {"dataType":"array","array":{"dataType":"refObject","ref":"TeamInformationBrief"},"required":true},
            "nextCursor": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIGetTeamsListOptions": {
        "dataType": "refObject",
        "properties": {
            "search": {"dataType":"string"},
            "subgroupsOnly": {"dataType":"boolean"},
            "includeUsers": {"dataType":"boolean"},
            "includeArchived": {"dataType":"boolean","default":false},
            "limit": {"dataType":"double","default":20},
            "cursor": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "OrgChartNode": {
        "dataType": "refObject",
        "properties": {
            "id": {"dataType":"string","required":true},
            "name": {"dataType":"string","required":true},
            "type": {"dataType":"union","subSchemas":[{"dataType":"enum","enums":["ROOT_MEMBER"]},{"dataType":"enum","enums":["DIVISION"]},{"dataType":"enum","enums":["PERSON"]}],"required":true},
            "attributes": {"dataType":"nestedObjectLiteral","nestedProperties":{"teamContext":{"dataType":"array","array":{"dataType":"string"}},"email":{"dataType":"string"},"role":{"dataType":"string"},"description":{"dataType":"string"},"friendlyName":{"dataType":"string"}},"additionalProperties":{"dataType":"any"}},
            "children": {"dataType":"array","array":{"dataType":"refObject","ref":"OrgChartNode"}},
            "siblings": {"dataType":"array","array":{"dataType":"refObject","ref":"OrgChartNode"}},
            "isPrimaryExpansion": {"dataType":"boolean"},
            "hasChildren": {"dataType":"boolean"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIGetOrgChartResponse": {
        "dataType": "refObject",
        "properties": {
            "root": {"ref":"OrgChartNode","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIGetOrgChartOptions": {
        "dataType": "refObject",
        "properties": {
            "expandAll": {"dataType":"boolean","default":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APITeamInviteCreateRequest": {
        "dataType": "refObject",
        "properties": {
            "inviteeName": {"dataType":"string","required":true},
            "inviteeEmail": {"dataType":"string","required":true},
            "roleTitle": {"dataType":"string","required":true},
            "subteamPk": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APITeamInviteGetResponse": {
        "dataType": "refObject",
        "properties": {
            "inviteName": {"dataType":"string","required":true},
            "inviteEmail": {"dataType":"string","required":true},
            "roleTitle": {"dataType":"string","required":true},
            "teamPk": {"dataType":"string","required":true},
            "subteamPk": {"dataType":"string","required":true},
            "inviterPk": {"dataType":"double","required":true},
            "expiresAt": {"dataType":"datetime","required":true},
            "slackInviteLink": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APITeamInviteAcceptRequest": {
        "dataType": "refObject",
        "properties": {
            "password": {"dataType":"string","required":true},
            "major": {"dataType":"string","required":true},
            "expectedGrad": {"dataType":"datetime","required":true},
            "phoneNumber": {"dataType":"string","required":true},
            "linkedinUrl": {"dataType":"string"},
            "avatarKey": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetGroupInfoResponse": {
        "dataType": "refObject",
        "properties": {
            "pk": {"dataType":"string","required":true},
            "name": {"dataType":"string","required":true},
            "users": {"dataType":"array","array":{"dataType":"refObject","ref":"UserInformationBrief"},"required":true},
            "parentPk": {"dataType":"string","required":true},
            "parentInfo": {"ref":"GetGroupInfoResponse"},
            "subteamPkList": {"dataType":"array","array":{"dataType":"string"},"required":true},
            "subteams": {"dataType":"array","array":{"dataType":"refObject","ref":"GetGroupInfoResponse"},"required":true},
            "attributes": {"ref":"TeamAttributeDefinition","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "TeamAttributeDefinition": {
        "dataType": "refObject",
        "properties": {
            "friendlyName": {"dataType":"string","required":true},
            "teamType": {"ref":"TeamType","required":true},
            "seasonType": {"dataType":"union","subSchemas":[{"ref":"SeasonType"},{"ref":"ServiceSeasonType"}],"required":true},
            "seasonYear": {"dataType":"double","required":true},
            "teamStartDate": {"dataType":"string"},
            "teamEndDate": {"dataType":"string"},
            "peoplePortalCreation": {"dataType":"boolean"},
            "flaggedForDeletion": {"dataType":"boolean"},
            "archivedAt": {"dataType":"string"},
            "archivedBy": {"dataType":"string"},
            "description": {"dataType":"string","required":true},
            "rootTeamSettings": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"ref":"EnabledRootSettings"},"required":true},
            "bindlePermissions": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"ref":"EnabledBindlePermissions"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APITeamInfoResponse": {
        "dataType": "refObject",
        "properties": {
            "team": {"ref":"GetGroupInfoResponse","required":true},
            "subteams": {"dataType":"array","array":{"dataType":"refObject","ref":"GetGroupInfoResponse"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APICreateSubTeamRequest": {
        "dataType": "refObject",
        "properties": {
            "friendlyName": {"dataType":"string","required":true},
            "description": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APICreateTeamRequest": {
        "dataType": "refObject",
        "properties": {
            "friendlyName": {"dataType":"string","required":true},
            "teamType": {"ref":"TeamType","required":true},
            "seasonType": {"ref":"SeasonType","required":true},
            "seasonYear": {"dataType":"double","required":true},
            "description": {"dataType":"string","required":true},
            "teamStartDate": {"dataType":"string"},
            "teamEndDate": {"dataType":"string","required":true},
            "requestorRole": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "TeamCreationRequestStatus": {
        "dataType": "refEnum",
        "enums": ["PENDING","APPROVED","REJECTED"],
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APITeamCreationRequestResponse": {
        "dataType": "refObject",
        "properties": {
            "_id": {"dataType":"string","required":true},
            "requestorPk": {"dataType":"double","required":true},
            "requestorName": {"dataType":"string","required":true},
            "requestorEmail": {"dataType":"string","required":true},
            "createTeamRequest": {"ref":"APICreateTeamRequest","required":true},
            "status": {"ref":"TeamCreationRequestStatus","required":true},
            "createdAt": {"dataType":"datetime","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIUpdateTeamRequest": {
        "dataType": "refObject",
        "properties": {
            "friendlyName": {"dataType":"string","validators":{"minLength":{"value":1}}},
            "description": {"dataType":"string","validators":{"minLength":{"value":1}}},
            "teamStartDate": {"dataType":"string"},
            "teamEndDate": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "BindlePermission": {
        "dataType": "refObject",
        "properties": {
            "friendlyName": {"dataType":"string","required":true},
            "description": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "BindlePermissionMap": {
        "dataType": "refObject",
        "properties": {
        },
        "additionalProperties": {"ref":"BindlePermission"},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogOwningTeam": {
        "dataType": "refObject",
        "properties": {
            "id": {"dataType":"string","required":true},
            "slug": {"dataType":"string","required":true},
            "displayName": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogGiteaIdentity": {
        "dataType": "refObject",
        "properties": {
            "provider": {"dataType":"enum","enums":["gitea"],"required":true},
            "providerId": {"dataType":"string","required":true},
            "username": {"dataType":"string","required":true},
            "email": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogLeadReference": {
        "dataType": "refObject",
        "properties": {
            "id": {"dataType":"string"},
            "provider": {"dataType":"enum","enums":["authentik"],"required":true},
            "providerId": {"dataType":"string"},
            "username": {"dataType":"string","required":true},
            "name": {"dataType":"string","required":true},
            "email": {"dataType":"string"},
            "role": {"dataType":"string","required":true},
            "gitea": {"ref":"ProjectCatalogGiteaIdentity"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogRepositorySnapshotStatus": {
        "dataType": "refAlias",
        "type": {"dataType":"union","subSchemas":[{"dataType":"enum","enums":["verified"]},{"dataType":"enum","enums":["unconfigured"]},{"dataType":"enum","enums":["unavailable"]}],"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogRepository": {
        "dataType": "refObject",
        "properties": {
            "id": {"dataType":"double","required":true},
            "slug": {"dataType":"string","required":true},
            "fullName": {"dataType":"string","required":true},
            "url": {"dataType":"string"},
            "archived": {"dataType":"boolean","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogGitSource": {
        "dataType": "refObject",
        "properties": {
            "provider": {"dataType":"enum","enums":["gitea"],"required":true},
            "organization": {"dataType":"string","required":true},
            "organizationSource": {"dataType":"enum","enums":["people-portal-team-name"],"required":true},
            "repositorySnapshot": {"ref":"ProjectCatalogRepositorySnapshotStatus","required":true},
            "memberSnapshot": {"ref":"ProjectCatalogRepositorySnapshotStatus","required":true},
            "repositories": {"dataType":"array","array":{"dataType":"refObject","ref":"ProjectCatalogRepository"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogSowMetadata": {
        "dataType": "refObject",
        "properties": {
            "reference": {"dataType":"string"},
            "title": {"dataType":"string"},
            "effectiveFrom": {"dataType":"string"},
            "effectiveTo": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogRevision": {
        "dataType": "refObject",
        "properties": {
            "value": {"dataType":"string","required":true},
            "effectiveFrom": {"dataType":"string"},
            "effectiveTo": {"dataType":"string"},
            "observedAt": {"dataType":"datetime","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogEntry": {
        "dataType": "refObject",
        "properties": {
            "id": {"dataType":"string","required":true},
            "slug": {"dataType":"string","required":true},
            "displayName": {"dataType":"string","required":true},
            "owningTeam": {"ref":"ProjectCatalogOwningTeam","required":true},
            "leads": {"dataType":"array","array":{"dataType":"refObject","ref":"ProjectCatalogLeadReference"},"required":true},
            "gitea": {"ref":"ProjectCatalogGitSource","required":true},
            "sow": {"ref":"ProjectCatalogSowMetadata"},
            "revision": {"ref":"ProjectCatalogRevision","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogIdentityIssueCode": {
        "dataType": "refAlias",
        "type": {"dataType":"union","subSchemas":[{"dataType":"enum","enums":["missing-email"]},{"dataType":"enum","enums":["duplicate-email"]},{"dataType":"enum","enums":["missing-provider-id"]},{"dataType":"enum","enums":["duplicate-provider-id"]}],"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogIdentityIssue": {
        "dataType": "refObject",
        "properties": {
            "code": {"ref":"ProjectCatalogIdentityIssueCode","required":true},
            "provider": {"dataType":"union","subSchemas":[{"dataType":"enum","enums":["authentik"]},{"dataType":"enum","enums":["gitea"]}],"required":true},
            "projectIds": {"dataType":"array","array":{"dataType":"string"},"required":true},
            "personIds": {"dataType":"array","array":{"dataType":"string"},"required":true},
            "email": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ProjectCatalogResponse": {
        "dataType": "refObject",
        "properties": {
            "observedAt": {"dataType":"datetime","required":true},
            "projects": {"dataType":"array","array":{"dataType":"refObject","ref":"ProjectCatalogEntry"},"required":true},
            "identityIssues": {"dataType":"array","array":{"dataType":"refObject","ref":"ProjectCatalogIdentityIssue"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIProjectCatalogOptions": {
        "dataType": "refObject",
        "properties": {
            "includeArchived": {"dataType":"boolean"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "PlatformLicenseResponse": {
        "dataType": "refObject",
        "properties": {
            "licenseText": {"dataType":"string","required":true},
            "dependencies": {"dataType":"array","array":{"dataType":"nestedObjectLiteral","nestedProperties":{"version":{"dataType":"string","required":true},"name":{"dataType":"string","required":true}}},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APITeamMeetingResponse": {
        "dataType": "refObject",
        "properties": {
            "_id": {"dataType":"string","required":true},
            "teamPk": {"dataType":"string","required":true},
            "seriesId": {"dataType":"string","required":true},
            "recurring": {"dataType":"boolean","required":true},
            "name": {"dataType":"string","required":true},
            "description": {"dataType":"string","required":true},
            "start": {"dataType":"datetime","required":true},
            "end": {"dataType":"datetime","required":true},
            "createdBy": {"dataType":"double","required":true},
            "visibleToAll": {"dataType":"boolean","required":true},
            "createdAt": {"dataType":"datetime","required":true},
            "updatedAt": {"dataType":"datetime","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APITeamMeetingCreateRequest": {
        "dataType": "refObject",
        "properties": {
            "name": {"dataType":"string","required":true},
            "description": {"dataType":"string"},
            "start": {"dataType":"datetime","required":true},
            "end": {"dataType":"datetime","required":true},
            "recurring": {"dataType":"boolean"},
            "requiredAttendees": {"dataType":"array","array":{"dataType":"double"}},
            "optionalAttendees": {"dataType":"array","array":{"dataType":"double"}},
            "requiredSubteams": {"dataType":"array","array":{"dataType":"string"}},
            "optionalSubteams": {"dataType":"array","array":{"dataType":"string"}},
            "visibleToAll": {"dataType":"boolean"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "MeetingScope": {
        "dataType": "refAlias",
        "type": {"dataType":"union","subSchemas":[{"dataType":"enum","enums":["this"]},{"dataType":"enum","enums":["following"]},{"dataType":"enum","enums":["all"]}],"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APITeamMeetingUpdateRequest": {
        "dataType": "refObject",
        "properties": {
            "name": {"dataType":"string"},
            "description": {"dataType":"string"},
            "start": {"dataType":"datetime"},
            "end": {"dataType":"datetime"},
            "visibleToAll": {"dataType":"boolean"},
            "scope": {"ref":"MeetingScope"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIMeetingRosterMember": {
        "dataType": "refObject",
        "properties": {
            "pk": {"dataType":"double","required":true},
            "name": {"dataType":"string","required":true},
            "username": {"dataType":"string","required":true},
            "email": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "AttendanceRole": {
        "dataType": "refAlias",
        "type": {"dataType":"union","subSchemas":[{"dataType":"enum","enums":["required"]},{"dataType":"enum","enums":["optional"]}],"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIMyAttendanceItem": {
        "dataType": "refObject",
        "properties": {
            "_id": {"dataType":"string","required":true},
            "teamPk": {"dataType":"string","required":true},
            "seriesId": {"dataType":"string","required":true},
            "recurring": {"dataType":"boolean","required":true},
            "name": {"dataType":"string","required":true},
            "description": {"dataType":"string","required":true},
            "start": {"dataType":"datetime","required":true},
            "end": {"dataType":"datetime","required":true},
            "createdBy": {"dataType":"double","required":true},
            "visibleToAll": {"dataType":"boolean","required":true},
            "createdAt": {"dataType":"datetime","required":true},
            "updatedAt": {"dataType":"datetime","required":true},
            "role": {"ref":"AttendanceRole","required":true},
            "present": {"dataType":"boolean","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIMeetingAttendee": {
        "dataType": "refObject",
        "properties": {
            "userPk": {"dataType":"double","required":true},
            "name": {"dataType":"string","required":true},
            "role": {"ref":"AttendanceRole","required":true},
            "present": {"dataType":"boolean","required":true},
            "markedBy": {"dataType":"union","subSchemas":[{"dataType":"double"},{"dataType":"enum","enums":[null]}],"required":true},
            "markedAt": {"dataType":"union","subSchemas":[{"dataType":"datetime"},{"dataType":"enum","enums":[null]}],"required":true},
            "explicit": {"dataType":"boolean","required":true},
            "viaSubteam": {"dataType":"union","subSchemas":[{"dataType":"string"},{"dataType":"enum","enums":[null]}],"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIMeetingSubteamRef": {
        "dataType": "refObject",
        "properties": {
            "subteamPk": {"dataType":"string","required":true},
            "name": {"dataType":"string","required":true},
            "role": {"ref":"AttendanceRole","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIMeetingAttendanceResponse": {
        "dataType": "refObject",
        "properties": {
            "viewerPk": {"dataType":"double","required":true},
            "canManage": {"dataType":"boolean","required":true},
            "attendees": {"dataType":"array","array":{"dataType":"refObject","ref":"APIMeetingAttendee"},"required":true},
            "subteams": {"dataType":"array","array":{"dataType":"refObject","ref":"APIMeetingSubteamRef"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIAddAttendeeRequest": {
        "dataType": "refObject",
        "properties": {
            "userPk": {"dataType":"double","required":true},
            "role": {"ref":"AttendanceRole"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIAddSubteamRequest": {
        "dataType": "refObject",
        "properties": {
            "subteamPk": {"dataType":"string","required":true},
            "role": {"ref":"AttendanceRole"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "APIMarkAttendanceRequest": {
        "dataType": "refObject",
        "properties": {
            "present": {"dataType":"boolean","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GiteaRepositoryPermissions": {
        "dataType": "refObject",
        "properties": {
            "admin": {"dataType":"boolean","required":true},
            "push": {"dataType":"boolean","required":true},
            "pull": {"dataType":"boolean","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GiteaRepositoryInternalTracker": {
        "dataType": "refObject",
        "properties": {
            "enable_time_tracker": {"dataType":"boolean","required":true},
            "allow_only_contributors_to_track_time": {"dataType":"boolean","required":true},
            "enable_issue_dependencies": {"dataType":"boolean","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GiteaUser": {
        "dataType": "refObject",
        "properties": {
            "id": {"dataType":"double","required":true},
            "login": {"dataType":"string","required":true},
            "login_name": {"dataType":"string","required":true},
            "source_id": {"dataType":"double","required":true},
            "full_name": {"dataType":"string","required":true},
            "email": {"dataType":"string","required":true},
            "avatar_url": {"dataType":"string","required":true},
            "html_url": {"dataType":"string","required":true},
            "language": {"dataType":"string","required":true},
            "is_admin": {"dataType":"boolean","required":true},
            "last_login": {"dataType":"string","required":true},
            "created": {"dataType":"string","required":true},
            "restricted": {"dataType":"boolean","required":true},
            "active": {"dataType":"boolean","required":true},
            "prohibit_login": {"dataType":"boolean","required":true},
            "location": {"dataType":"string","required":true},
            "website": {"dataType":"string","required":true},
            "description": {"dataType":"string","required":true},
            "visibility": {"dataType":"string","required":true},
            "followers_count": {"dataType":"double","required":true},
            "following_count": {"dataType":"double","required":true},
            "starred_repos_count": {"dataType":"double","required":true},
            "username": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GiteaRepository": {
        "dataType": "refObject",
        "properties": {
            "owner": {"ref":"GiteaUser","required":true},
            "name": {"dataType":"string","required":true},
            "id": {"dataType":"double","required":true},
            "full_name": {"dataType":"string","required":true},
            "description": {"dataType":"string","required":true},
            "empty": {"dataType":"boolean","required":true},
            "private": {"dataType":"boolean","required":true},
            "fork": {"dataType":"boolean","required":true},
            "template": {"dataType":"boolean","required":true},
            "mirror": {"dataType":"boolean","required":true},
            "size": {"dataType":"double","required":true},
            "language": {"dataType":"string","required":true},
            "languages_url": {"dataType":"string","required":true},
            "html_url": {"dataType":"string","required":true},
            "url": {"dataType":"string","required":true},
            "link": {"dataType":"string","required":true},
            "ssh_url": {"dataType":"string","required":true},
            "clone_url": {"dataType":"string","required":true},
            "original_url": {"dataType":"string","required":true},
            "website": {"dataType":"string","required":true},
            "stars_count": {"dataType":"double","required":true},
            "forks_count": {"dataType":"double","required":true},
            "watchers_count": {"dataType":"double","required":true},
            "open_issues_count": {"dataType":"double","required":true},
            "open_pr_counter": {"dataType":"double","required":true},
            "release_counter": {"dataType":"double","required":true},
            "default_branch": {"dataType":"string","required":true},
            "archived": {"dataType":"boolean","required":true},
            "created_at": {"dataType":"string","required":true},
            "updated_at": {"dataType":"string","required":true},
            "archived_at": {"dataType":"string","required":true},
            "permissions": {"ref":"GiteaRepositoryPermissions","required":true},
            "has_issues": {"dataType":"boolean","required":true},
            "internal_tracker": {"ref":"GiteaRepositoryInternalTracker","required":true},
            "has_wiki": {"dataType":"boolean","required":true},
            "has_pull_requests": {"dataType":"boolean","required":true},
            "has_projects": {"dataType":"boolean","required":true},
            "projects_mode": {"dataType":"string","required":true},
            "has_releases": {"dataType":"boolean","required":true},
            "has_packages": {"dataType":"boolean","required":true},
            "has_actions": {"dataType":"boolean","required":true},
            "ignore_whitespace_conflicts": {"dataType":"boolean","required":true},
            "allow_merge_commits": {"dataType":"boolean","required":true},
            "allow_rebase": {"dataType":"boolean","required":true},
            "allow_rebase_explicit": {"dataType":"boolean","required":true},
            "allow_squash_merge": {"dataType":"boolean","required":true},
            "allow_fast_forward_only_merge": {"dataType":"boolean","required":true},
            "allow_rebase_update": {"dataType":"boolean","required":true},
            "default_delete_branch_after_merge": {"dataType":"boolean","required":true},
            "default_merge_style": {"dataType":"string","required":true},
            "default_allow_maintainer_edit": {"dataType":"boolean","required":true},
            "avatar_url": {"dataType":"string","required":true},
            "internal": {"dataType":"boolean","required":true},
            "mirror_interval": {"dataType":"string","required":true},
            "object_format_name": {"dataType":"string","required":true},
            "mirror_updated": {"dataType":"string","required":true},
            "topics": {"dataType":"array","array":{"dataType":"string"},"required":true},
            "licenses": {"dataType":"array","array":{"dataType":"string"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GiteaHookRepositoryTrigger": {
        "dataType": "refObject",
        "properties": {
            "action": {"dataType":"string","required":true},
            "repository": {"ref":"GiteaRepository","required":true},
            "organization": {"ref":"GiteaUser","required":true},
            "sender": {"ref":"GiteaUser","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GiteaCommitUser": {
        "dataType": "refObject",
        "properties": {
            "name": {"dataType":"string","required":true},
            "email": {"dataType":"string","required":true},
            "username": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GiteaCommit": {
        "dataType": "refObject",
        "properties": {
            "id": {"dataType":"string","required":true},
            "message": {"dataType":"string","required":true},
            "url": {"dataType":"string","required":true},
            "author": {"ref":"GiteaCommitUser","required":true},
            "committer": {"ref":"GiteaCommitUser","required":true},
            "verification": {"dataType":"any","required":true},
            "timestamp": {"dataType":"string","required":true},
            "added": {"dataType":"array","array":{"dataType":"string"},"required":true},
            "removed": {"dataType":"array","array":{"dataType":"string"},"required":true},
            "modified": {"dataType":"array","array":{"dataType":"string"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GiteaHookCommitTrigger": {
        "dataType": "refObject",
        "properties": {
            "ref": {"dataType":"string","required":true},
            "before": {"dataType":"string","required":true},
            "after": {"dataType":"string","required":true},
            "compare_url": {"dataType":"string","required":true},
            "commits": {"dataType":"array","array":{"dataType":"refObject","ref":"GiteaCommit"},"required":true},
            "total_commits": {"dataType":"double","required":true},
            "head_commit": {"ref":"GiteaCommit","required":true},
            "repository": {"ref":"GiteaRepository","required":true},
            "pusher": {"ref":"GiteaUser","required":true},
            "sender": {"ref":"GiteaUser","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetEventListResponse": {
        "dataType": "refObject",
        "properties": {
            "data": {"dataType":"array","array":{"dataType":"string"},"required":true},
            "count": {"dataType":"double","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetEventListOptions": {
        "dataType": "refObject",
        "properties": {
            "before": {"dataType":"datetime"},
            "after": {"dataType":"datetime"},
            "scopes": {"dataType":"array","array":{"dataType":"string"}},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "mongoose.FlattenMaps_IEvent_": {
        "dataType": "refAlias",
        "type": {"dataType":"nestedObjectLiteral","nestedProperties":{},"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "DocumentJSON_IEvent_": {
        "dataType": "refAlias",
        "type": {"dataType":"intersection","subSchemas":[{"ref":"mongoose.FlattenMaps_IEvent_"},{"ref":"Required___id-mongoose.Types.ObjectId__"},{"dataType":"nestedObjectLiteral","nestedProperties":{"__v":{"dataType":"double","required":true}}}],"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetEventResponse": {
        "dataType": "refObject",
        "properties": {
            "status": {"dataType":"string","required":true},
            "data": {"ref":"DocumentJSON_IEvent_","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "CreateEventResponse": {
        "dataType": "refObject",
        "properties": {
            "eventId": {"dataType":"string","required":true},
            "status": {"dataType":"string","required":true},
            "issues": {"dataType":"array","array":{"dataType":"string"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "CreateEventRequest": {
        "dataType": "refObject",
        "properties": {
            "title": {"dataType":"string","required":true},
            "description": {"dataType":"string","required":true},
            "startTime": {"dataType":"datetime","required":true},
            "endTime": {"dataType":"datetime","required":true},
            "location": {"dataType":"string","required":true},
            "scope": {"dataType":"string","required":true},
            "marketingChannels": {"dataType":"array","array":{"dataType":"string"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "BasicEventResponse": {
        "dataType": "refObject",
        "properties": {
            "status": {"dataType":"string","required":true},
            "message": {"dataType":"string"},
            "issues": {"dataType":"array","array":{"dataType":"string"},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "UpdateEventRequest": {
        "dataType": "refObject",
        "properties": {
            "notify": {"dataType":"boolean","required":true},
            "eventName": {"dataType":"string"},
            "eventDescription": {"dataType":"string"},
            "startTime": {"dataType":"datetime"},
            "endTime": {"dataType":"datetime"},
            "location": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "mongoose.FlattenMaps_IRsvp_": {
        "dataType": "refAlias",
        "type": {"dataType":"nestedObjectLiteral","nestedProperties":{},"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "DocumentJSON_IRsvp_": {
        "dataType": "refAlias",
        "type": {"dataType":"intersection","subSchemas":[{"ref":"mongoose.FlattenMaps_IRsvp_"},{"ref":"Required___id-mongoose.Types.ObjectId__"},{"dataType":"nestedObjectLiteral","nestedProperties":{"__v":{"dataType":"double","required":true}}}],"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetRsvpResponse": {
        "dataType": "refObject",
        "properties": {
            "status": {"dataType":"string","required":true},
            "data": {"dataType":"array","array":{"dataType":"refAlias","ref":"DocumentJSON_IRsvp_"},"required":true},
            "pagination": {"dataType":"nestedObjectLiteral","nestedProperties":{"totalPages":{"dataType":"double","required":true}},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetRsvpsRequest": {
        "dataType": "refObject",
        "properties": {
            "page": {"dataType":"double","required":true},
            "pageSize": {"dataType":"double"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "RsvpRequest": {
        "dataType": "refObject",
        "properties": {
            "accept": {"dataType":"boolean","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "GetEventRsvpResponse": {
        "dataType": "refObject",
        "properties": {
            "status": {"dataType":"string","required":true},
            "rsvp": {"dataType":"union","subSchemas":[{"ref":"DocumentJSON_IRsvp_"},{"dataType":"enum","enums":[null]}],"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "JsonPrimitive": {
        "dataType": "refAlias",
        "type": {"dataType":"union","subSchemas":[{"dataType":"string"},{"dataType":"double"},{"dataType":"boolean"},{"dataType":"enum","enums":[null]}],"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "JsonValue": {
        "dataType": "refAlias",
        "type": {"dataType":"union","subSchemas":[{"ref":"JsonPrimitive"},{"ref":"JsonObject"},{"ref":"JsonArray"}],"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "JsonObject": {
        "dataType": "refAlias",
        "type": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"ref":"JsonValue"},"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "JsonArray": {
        "dataType": "refAlias",
        "type": {"dataType":"array","array":{"dataType":"refAlias","ref":"JsonValue"},"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "UserInfoAddress": {
        "dataType": "refObject",
        "properties": {
            "formatted": {"dataType":"string"},
            "street_address": {"dataType":"string"},
            "locality": {"dataType":"string"},
            "region": {"dataType":"string"},
            "postal_code": {"dataType":"string"},
            "country": {"dataType":"string"},
        },
        "additionalProperties": {"dataType":"union","subSchemas":[{"ref":"JsonValue"},{"dataType":"undefined"}]},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "CorpUserInfoResponse": {
        "dataType": "refObject",
        "properties": {
            "sub": {"dataType":"string","required":true},
            "name": {"dataType":"string"},
            "given_name": {"dataType":"string"},
            "family_name": {"dataType":"string"},
            "middle_name": {"dataType":"string"},
            "nickname": {"dataType":"string"},
            "preferred_username": {"dataType":"string"},
            "profile": {"dataType":"string"},
            "picture": {"dataType":"string"},
            "website": {"dataType":"string"},
            "email": {"dataType":"string"},
            "email_verified": {"dataType":"boolean"},
            "gender": {"dataType":"string"},
            "birthdate": {"dataType":"string"},
            "zoneinfo": {"dataType":"string"},
            "locale": {"dataType":"string"},
            "phone_number": {"dataType":"string"},
            "updated_at": {"dataType":"double"},
            "address": {"ref":"UserInfoAddress"},
            "avatar": {"dataType":"string","required":true},
            "isExecutive": {"dataType":"boolean","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "OtpInitRequest": {
        "dataType": "refObject",
        "properties": {
            "email": {"dataType":"string","required":true},
            "name": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "OtpVerifyRequest": {
        "dataType": "refObject",
        "properties": {
            "email": {"dataType":"string","required":true},
            "otp": {"dataType":"string","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "Fields": {
        "dataType": "refAlias",
        "type": {"ref":"Record_string.string_","validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "mongoose.FlattenMaps_ISubteamConfig_": {
        "dataType": "refAlias",
        "type": {"dataType":"nestedObjectLiteral","nestedProperties":{},"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ATSSubteamConfigRequest": {
        "dataType": "refObject",
        "properties": {
            "isRecruiting": {"dataType":"boolean","required":true},
            "roles": {"dataType":"array","array":{"dataType":"string"},"required":true},
            "roleSpecificQuestions": {"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"dataType":"array","array":{"dataType":"string"}},"required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ApplicationStage": {
        "dataType": "refEnum",
        "enums": ["Applied","Interview","Rejected","Potential Hire","Hired"],
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "Record_string.string-Array_": {
        "dataType": "refAlias",
        "type": {"dataType":"nestedObjectLiteral","nestedProperties":{},"validators":{}},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ATSKanbanApplicationCard": {
        "dataType": "refObject",
        "properties": {
            "id": {"dataType":"string","required":true},
            "applicantId": {"dataType":"string","required":true},
            "name": {"dataType":"string","required":true},
            "rolePreferences": {"dataType":"array","array":{"dataType":"nestedObjectLiteral","nestedProperties":{"subteamPk":{"dataType":"string","required":true},"role":{"dataType":"string","required":true}}},"required":true},
            "appliedAt": {"dataType":"datetime","required":true},
            "stage": {"ref":"ApplicationStage","required":true},
            "stars": {"dataType":"double","required":true,"validators":{"minimum":{"errorMsg":"Minimum Stars is 0","value":0},"maximum":{"errorMsg":"Maximum Stars is 5","value":5}}},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ATSApplicationDetails": {
        "dataType": "refObject",
        "properties": {
            "id": {"dataType":"string","required":true},
            "applicantId": {"dataType":"string","required":true},
            "name": {"dataType":"string","required":true},
            "rolePreferences": {"dataType":"array","array":{"dataType":"nestedObjectLiteral","nestedProperties":{"subteamPk":{"dataType":"string","required":true},"role":{"dataType":"string","required":true}}},"required":true},
            "appliedAt": {"dataType":"datetime","required":true},
            "stage": {"ref":"ApplicationStage","required":true},
            "stars": {"dataType":"double","required":true,"validators":{"minimum":{"errorMsg":"Minimum Stars is 0","value":0},"maximum":{"errorMsg":"Maximum Stars is 5","value":5}}},
            "email": {"dataType":"string","required":true},
            "profile": {"ref":"Record_string.string_","required":true},
            "responses": {"ref":"Record_string.string_","required":true},
            "stageHistory": {"dataType":"array","array":{"dataType":"nestedObjectLiteral","nestedProperties":{"changedBy":{"dataType":"string"},"changedAt":{"dataType":"datetime","required":true},"stage":{"ref":"ApplicationStage","required":true}}}},
            "hiredRole": {"dataType":"string"},
            "appDevInternalPk": {"dataType":"double"},
            "notes": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ATSUpdateApplicationStageRequest": {
        "dataType": "refObject",
        "properties": {
            "stage": {"ref":"ApplicationStage","required":true},
            "interviewLink": {"dataType":"string"},
            "interviewGuidelines": {"dataType":"string"},
            "hiredRole": {"dataType":"string"},
            "hiredSubteamPk": {"dataType":"string"},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ApplicantProfile": {
        "dataType": "refObject",
        "properties": {
            "resumeUrl": {"dataType":"string","required":true},
            "whyAppDev": {"dataType":"string","required":true},
            "instagramFollow": {"dataType":"string","required":true},
            "linkedinUrl": {"dataType":"string"},
            "githubUrl": {"dataType":"string"},
        },
        "additionalProperties": {"dataType":"union","subSchemas":[{"dataType":"string"},{"dataType":"undefined"}]},
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
    "ATSTeamApplicationRequest": {
        "dataType": "refObject",
        "properties": {
            "teamPk": {"dataType":"string","required":true},
            "rolePreferences": {"dataType":"array","array":{"dataType":"nestedObjectLiteral","nestedProperties":{"subteamPk":{"dataType":"string","required":true},"role":{"dataType":"string","required":true}}},"required":true},
            "profile": {"ref":"ApplicantProfile","required":true},
            "responses": {"ref":"Record_string.string_","required":true},
        },
        "additionalProperties": false,
    },
    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
};
const templateService = new ExpressTemplateService(models, {"noImplicitAdditionalProperties":"throw-on-extras","bodyCoercion":true});

// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa




export function RegisterRoutes(app: Router) {

    // ###########################################################################################################
    //  NOTE: If you do not see routes for all of your controllers in this file, then you might not have informed tsoa of where to look
    //      Please look into the "controllerPathGlobs" config option described in the readme: https://github.com/lukeautry/tsoa
    // ###########################################################################################################


    
        const argsOrgController_getPeople: Record<string, TsoaRoute.ParameterSchema> = {
                options: {"in":"queries","name":"options","required":true,"ref":"GetUserListOptions"},
        };
        app.get('/api/org/people',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getPeople)),

            async function OrgController_getPeople(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getPeople, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getPeople',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getPersonInfo: Record<string, TsoaRoute.ParameterSchema> = {
                personId: {"in":"path","name":"personId","required":true,"dataType":"double"},
        };
        app.get('/api/org/people/:personId',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getPersonInfo)),

            async function OrgController_getPersonInfo(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getPersonInfo, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getPersonInfo',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getCommonTeams: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                personId: {"in":"path","name":"personId","required":true,"dataType":"double"},
        };
        app.get('/api/org/people/:personId/commonteams',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getCommonTeams)),

            async function OrgController_getCommonTeams(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getCommonTeams, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getCommonTeams',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getReview: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                personId: {"in":"path","name":"personId","required":true,"dataType":"double"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/org/people/:personId/reviews/:teamId',
            authenticateMiddleware([{"bindles":["corp:reviewaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getReview)),

            async function OrgController_getReview(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getReview, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getReview',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getReviews: Record<string, TsoaRoute.ParameterSchema> = {
                personId: {"in":"path","name":"personId","required":true,"dataType":"double"},
                options: {"in":"queries","name":"options","required":true,"ref":"APIGetReviewsOptions"},
        };
        app.get('/api/org/people/:personId/reviews',
            authenticateMiddleware([{"executive":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getReviews)),

            async function OrgController_getReviews(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getReviews, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getReviews',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_writeReview: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                personId: {"in":"path","name":"personId","required":true,"dataType":"double"},
                body: {"in":"body","name":"body","required":true,"ref":"APICreateReviewRequest"},
        };
        app.post('/api/org/people/:personId/reviews',
            authenticateMiddleware([{"bindles":["body.teamId","corp:reviewaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.writeReview)),

            async function OrgController_writeReview(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_writeReview, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'writeReview',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_editReview: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                personId: {"in":"path","name":"personId","required":true,"dataType":"double"},
                reviewId: {"in":"path","name":"reviewId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"APICreateReviewRequest"},
        };
        app.put('/api/org/people/:personId/reviews/:reviewId',
            authenticateMiddleware([{"bindles":["body.teamId","corp:reviewaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.editReview)),

            async function OrgController_editReview(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_editReview, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'editReview',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_deleteReview: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                personId: {"in":"path","name":"personId","required":true,"dataType":"double"},
                reviewId: {"in":"path","name":"reviewId","required":true,"dataType":"string"},
        };
        app.delete('/api/org/people/:personId/reviews/:reviewId',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.deleteReview)),

            async function OrgController_deleteReview(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_deleteReview, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'deleteReview',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 204,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_updatePersonInfo: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                personId: {"in":"path","name":"personId","required":true,"dataType":"double"},
                body: {"in":"body","name":"body","required":true,"dataType":"nestedObjectLiteral","nestedProperties":{"avatarKey":{"dataType":"string"},"linkedinUrl":{"dataType":"string"},"phoneNumber":{"dataType":"string"},"expectedGrad":{"dataType":"string"},"major":{"dataType":"string"}}},
        };
        app.patch('/api/org/people/:personId',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.updatePersonInfo)),

            async function OrgController_updatePersonInfo(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_updatePersonInfo, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'updatePersonInfo',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getProfileAvatarUploadUrl: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                fileName: {"in":"query","name":"fileName","required":true,"dataType":"string"},
                contentType: {"in":"query","name":"contentType","required":true,"dataType":"string"},
        };
        app.get('/api/org/people/avatar/profile-upload-url',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getProfileAvatarUploadUrl)),

            async function OrgController_getProfileAvatarUploadUrl(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getProfileAvatarUploadUrl, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getProfileAvatarUploadUrl',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getUserRootTeams: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                username: {"in":"path","name":"username","required":true,"dataType":"string"},
        };
        app.get('/api/org/people/:username/memberof',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getUserRootTeams)),

            async function OrgController_getUserRootTeams(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getUserRootTeams, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getUserRootTeams',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getUserTeamMemberships: Record<string, TsoaRoute.ParameterSchema> = {
                username: {"in":"path","name":"username","required":true,"dataType":"string"},
        };
        app.get('/api/org/people/:username/memberships',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getUserTeamMemberships)),

            async function OrgController_getUserTeamMemberships(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getUserTeamMemberships, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getUserTeamMemberships',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_listRootTeamSettings: Record<string, TsoaRoute.ParameterSchema> = {
        };
        app.get('/api/org/teamsettings',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.listRootTeamSettings)),

            async function OrgController_listRootTeamSettings(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_listRootTeamSettings, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'listRootTeamSettings',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getTeams: Record<string, TsoaRoute.ParameterSchema> = {
                options: {"in":"queries","name":"options","required":true,"ref":"APIGetTeamsListOptions"},
        };
        app.get('/api/org/teams',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getTeams)),

            async function OrgController_getTeams(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getTeams, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getTeams',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getOrgChart: Record<string, TsoaRoute.ParameterSchema> = {
                options: {"in":"queries","name":"options","ref":"APIGetOrgChartOptions"},
        };
        app.get('/api/org/orgchart',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getOrgChart)),

            async function OrgController_getOrgChart(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getOrgChart, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getOrgChart',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getOrgChartNode: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/org/orgchart/node/:teamId',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getOrgChartNode)),

            async function OrgController_getOrgChartNode(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getOrgChartNode, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getOrgChartNode',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getMyTeams: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
        };
        app.get('/api/org/myteams',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getMyTeams)),

            async function OrgController_getMyTeams(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getMyTeams, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getMyTeams',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_createInvite: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                inviteReq: {"in":"body","name":"inviteReq","required":true,"ref":"APITeamInviteCreateRequest"},
                _teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.post('/api/org/teams/:teamId/externalinvite',
            authenticateMiddleware([{"bindles":["corp:membermgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.createInvite)),

            async function OrgController_createInvite(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_createInvite, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'createInvite',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getAvatarUploadUrl: Record<string, TsoaRoute.ParameterSchema> = {
                inviteId: {"in":"query","name":"inviteId","required":true,"dataType":"string"},
                fileName: {"in":"query","name":"fileName","required":true,"dataType":"string"},
                contentType: {"in":"query","name":"contentType","required":true,"dataType":"string"},
        };
        app.get('/api/org/people/avatar/upload-url',
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getAvatarUploadUrl)),

            async function OrgController_getAvatarUploadUrl(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getAvatarUploadUrl, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getAvatarUploadUrl',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getAvatarDownloadUrl: Record<string, TsoaRoute.ParameterSchema> = {
                userPk: {"in":"query","name":"userPk","required":true,"dataType":"string"},
        };
        app.get('/api/org/people/avatar/download-url',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getAvatarDownloadUrl)),

            async function OrgController_getAvatarDownloadUrl(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getAvatarDownloadUrl, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getAvatarDownloadUrl',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getInviteInfo: Record<string, TsoaRoute.ParameterSchema> = {
                inviteId: {"in":"path","name":"inviteId","required":true,"dataType":"string"},
        };
        app.get('/api/org/invites/:inviteId',
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getInviteInfo)),

            async function OrgController_getInviteInfo(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getInviteInfo, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getInviteInfo',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_acceptInvite: Record<string, TsoaRoute.ParameterSchema> = {
                inviteId: {"in":"path","name":"inviteId","required":true,"dataType":"string"},
                req: {"in":"body","name":"req","required":true,"ref":"APITeamInviteAcceptRequest"},
        };
        app.put('/api/org/invites/:inviteId',
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.acceptInvite)),

            async function OrgController_acceptInvite(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_acceptInvite, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'acceptInvite',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_verifySlack: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"body","name":"req","required":true,"dataType":"nestedObjectLiteral","nestedProperties":{"email":{"dataType":"string","required":true}}},
        };
        app.post('/api/org/tools/verifyslack',
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.verifySlack)),

            async function OrgController_verifySlack(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_verifySlack, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'verifySlack',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getTeamInfo: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/org/teams/:teamId',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getTeamInfo)),

            async function OrgController_getTeamInfo(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getTeamInfo, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getTeamInfo',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getTeamBindles: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/org/teams/:teamId/bindles',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getTeamBindles)),

            async function OrgController_getTeamBindles(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getTeamBindles, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getTeamBindles',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_updateTeamBindles: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                bindleConf: {"in":"body","name":"bindleConf","required":true,"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"ref":"EnabledBindlePermissions"}},
        };
        app.patch('/api/org/teams/:teamId/bindles',
            authenticateMiddleware([{"bindles":["corp:permissionsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.updateTeamBindles)),

            async function OrgController_updateTeamBindles(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_updateTeamBindles, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'updateTeamBindles',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_fetchAWSAccessCredentials: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/org/teams/:teamId/awsaccess',
            authenticateMiddleware([{"bindles":["corp:awsaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.fetchAWSAccessCredentials)),

            async function OrgController_fetchAWSAccessCredentials(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_fetchAWSAccessCredentials, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'fetchAWSAccessCredentials',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_updateRootTeamSetting: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                conf: {"in":"body","name":"conf","required":true,"dataType":"nestedObjectLiteral","nestedProperties":{},"additionalProperties":{"ref":"EnabledRootSettings"}},
        };
        app.patch('/api/org/teams/:teamId/updateconf',
            authenticateMiddleware([{"bindles":["corp:rootsettings"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.updateRootTeamSetting)),

            async function OrgController_updateRootTeamSetting(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_updateRootTeamSetting, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'updateRootTeamSetting',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_addTeamMember: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                req: {"in":"body","name":"req","required":true,"dataType":"nestedObjectLiteral","nestedProperties":{"roleTitle":{"dataType":"string","required":true},"userPk":{"dataType":"double","required":true}}},
        };
        app.post('/api/org/teams/:teamId/addmember',
            authenticateMiddleware([{"bindles":["corp:membermgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.addTeamMember)),

            async function OrgController_addTeamMember(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_addTeamMember, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'addTeamMember',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_removeTeamMember: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"dataType":"nestedObjectLiteral","nestedProperties":{"userPk":{"dataType":"double","required":true}}},
        };
        app.post('/api/org/teams/:teamId/removemember',
            authenticateMiddleware([{"bindles":["corp:membermgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.removeTeamMember)),

            async function OrgController_removeTeamMember(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_removeTeamMember, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'removeTeamMember',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_createSubTeam: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"APICreateSubTeamRequest"},
        };
        app.post('/api/org/teams/:teamId/subteam',
            authenticateMiddleware([{"bindles":["corp:subteamaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.createSubTeam)),

            async function OrgController_createSubTeam(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_createSubTeam, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'createSubTeam',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_getTeamCreationRequest: Record<string, TsoaRoute.ParameterSchema> = {
                requestId: {"in":"path","name":"requestId","required":true,"dataType":"string"},
        };
        app.get('/api/org/teamrequests/:requestId',
            authenticateMiddleware([{"executive":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.getTeamCreationRequest)),

            async function OrgController_getTeamCreationRequest(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_getTeamCreationRequest, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'getTeamCreationRequest',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_approveTeamCreationRequest: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                requestId: {"in":"path","name":"requestId","required":true,"dataType":"string"},
        };
        app.post('/api/org/teamrequests/:requestId',
            authenticateMiddleware([{"executive":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.approveTeamCreationRequest)),

            async function OrgController_approveTeamCreationRequest(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_approveTeamCreationRequest, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'approveTeamCreationRequest',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_declineTeamCreationRequest: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                requestId: {"in":"path","name":"requestId","required":true,"dataType":"string"},
        };
        app.delete('/api/org/teamrequests/:requestId',
            authenticateMiddleware([{"executive":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.declineTeamCreationRequest)),

            async function OrgController_declineTeamCreationRequest(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_declineTeamCreationRequest, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'declineTeamCreationRequest',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_createTeam: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                createTeamReq: {"in":"body","name":"createTeamReq","required":true,"ref":"APICreateTeamRequest"},
        };
        app.post('/api/org/teams/create',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.createTeam)),

            async function OrgController_createTeam(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_createTeam, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'createTeam',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_syncOrgBindles: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.patch('/api/org/teams/:teamId/syncbindles',
            authenticateMiddleware([{"bindles":["corp:bindlesync"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.syncOrgBindles)),

            async function OrgController_syncOrgBindles(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_syncOrgBindles, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'syncOrgBindles',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_updateTeamAttributes: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                conf: {"in":"body","name":"conf","required":true,"ref":"APIUpdateTeamRequest"},
        };
        app.patch('/api/org/teams/:teamId',
            authenticateMiddleware([{"bindles":["corp:rootsettings"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.updateTeamAttributes)),

            async function OrgController_updateTeamAttributes(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_updateTeamAttributes, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'updateTeamAttributes',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_deleteTeam: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.delete('/api/org/teams/:teamId',
            authenticateMiddleware([{"bindles":["corp:subteamaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.deleteTeam)),

            async function OrgController_deleteTeam(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_deleteTeam, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'deleteTeam',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsOrgController_archiveTeam: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.post('/api/org/teams/:teamId/archive',
            authenticateMiddleware([{"bindles":["corp:subteamaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(OrgController)),
            ...(fetchMiddlewares<RequestHandler>(OrgController.prototype.archiveTeam)),

            async function OrgController_archiveTeam(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsOrgController_archiveTeam, request, response });

                const controller = new OrgController();

              await templateService.apiHandler({
                methodName: 'archiveTeam',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsBindleController_getDefinitions: Record<string, TsoaRoute.ParameterSchema> = {
        };
        app.get('/api/bindles/definitions',
            ...(fetchMiddlewares<RequestHandler>(BindleController)),
            ...(fetchMiddlewares<RequestHandler>(BindleController.prototype.getDefinitions)),

            async function BindleController_getDefinitions(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsBindleController_getDefinitions, request, response });

                const controller = new BindleController();

              await templateService.apiHandler({
                methodName: 'getDefinitions',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsProjectCatalogController_getProjectCatalog: Record<string, TsoaRoute.ParameterSchema> = {
                options: {"in":"queries","name":"options","required":true,"ref":"APIProjectCatalogOptions"},
        };
        app.get('/api/projects/catalog',
            authenticateMiddleware([{"oidc":[]},{"service":[]}]),
            ...(fetchMiddlewares<RequestHandler>(ProjectCatalogController)),
            ...(fetchMiddlewares<RequestHandler>(ProjectCatalogController.prototype.getProjectCatalog)),

            async function ProjectCatalogController_getProjectCatalog(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsProjectCatalogController_getProjectCatalog, request, response });

                const controller = new ProjectCatalogController();

              await templateService.apiHandler({
                methodName: 'getProjectCatalog',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsPlatformController_getPlatformLicense: Record<string, TsoaRoute.ParameterSchema> = {
        };
        app.get('/api/platform/license',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(PlatformController)),
            ...(fetchMiddlewares<RequestHandler>(PlatformController.prototype.getPlatformLicense)),

            async function PlatformController_getPlatformLicense(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsPlatformController_getPlatformLicense, request, response });

                const controller = new PlatformController();

              await templateService.apiHandler({
                methodName: 'getPlatformLicense',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_getTeamMeetings: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                from: {"in":"query","name":"from","dataType":"datetime"},
                to: {"in":"query","name":"to","dataType":"datetime"},
        };
        app.get('/api/org/teams/:teamId/meetings',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.getTeamMeetings)),

            async function MeetingsController_getTeamMeetings(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_getTeamMeetings, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'getTeamMeetings',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_createTeamMeeting: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"APITeamMeetingCreateRequest"},
        };
        app.post('/api/org/teams/:teamId/meetings',
            authenticateMiddleware([{"bindles":["corp:meetingsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.createTeamMeeting)),

            async function MeetingsController_createTeamMeeting(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_createTeamMeeting, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'createTeamMeeting',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_updateTeamMeeting: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"APITeamMeetingUpdateRequest"},
        };
        app.patch('/api/org/teams/:teamId/meetings/:meetingId',
            authenticateMiddleware([{"bindles":["corp:meetingsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.updateTeamMeeting)),

            async function MeetingsController_updateTeamMeeting(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_updateTeamMeeting, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'updateTeamMeeting',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_deleteTeamMeeting: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
                scope: {"in":"query","name":"scope","ref":"MeetingScope"},
        };
        app.delete('/api/org/teams/:teamId/meetings/:meetingId',
            authenticateMiddleware([{"bindles":["corp:meetingsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.deleteTeamMeeting)),

            async function MeetingsController_deleteTeamMeeting(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_deleteTeamMeeting, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'deleteTeamMeeting',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 204,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_getMeetingRoster: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/org/teams/:teamId/meetings/roster',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.getMeetingRoster)),

            async function MeetingsController_getMeetingRoster(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_getMeetingRoster, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'getMeetingRoster',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_getMeetingCapabilities: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/org/teams/:teamId/meetings/capabilities',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.getMeetingCapabilities)),

            async function MeetingsController_getMeetingCapabilities(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_getMeetingCapabilities, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'getMeetingCapabilities',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_getMyAttendance: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                from: {"in":"query","name":"from","dataType":"datetime"},
                to: {"in":"query","name":"to","dataType":"datetime"},
        };
        app.get('/api/org/teams/:teamId/meetings/mine',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.getMyAttendance)),

            async function MeetingsController_getMyAttendance(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_getMyAttendance, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'getMyAttendance',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_getTeamMeeting: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
        };
        app.get('/api/org/teams/:teamId/meetings/:meetingId',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.getTeamMeeting)),

            async function MeetingsController_getTeamMeeting(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_getTeamMeeting, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'getTeamMeeting',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_checkInToMeeting: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
        };
        app.post('/api/org/teams/:teamId/meetings/:meetingId/checkin',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.checkInToMeeting)),

            async function MeetingsController_checkInToMeeting(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_checkInToMeeting, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'checkInToMeeting',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_getMeetingAttendance: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
        };
        app.get('/api/org/teams/:teamId/meetings/:meetingId/attendance',
            authenticateMiddleware([{"bindles":["corp:meetingsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.getMeetingAttendance)),

            async function MeetingsController_getMeetingAttendance(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_getMeetingAttendance, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'getMeetingAttendance',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_addMeetingAttendee: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"APIAddAttendeeRequest"},
        };
        app.post('/api/org/teams/:teamId/meetings/:meetingId/attendance',
            authenticateMiddleware([{"bindles":["corp:meetingsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.addMeetingAttendee)),

            async function MeetingsController_addMeetingAttendee(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_addMeetingAttendee, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'addMeetingAttendee',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_addMeetingSubteam: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"APIAddSubteamRequest"},
        };
        app.post('/api/org/teams/:teamId/meetings/:meetingId/attendance/subteams',
            authenticateMiddleware([{"bindles":["corp:meetingsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.addMeetingSubteam)),

            async function MeetingsController_addMeetingSubteam(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_addMeetingSubteam, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'addMeetingSubteam',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_removeMeetingSubteam: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
                subteamPk: {"in":"path","name":"subteamPk","required":true,"dataType":"string"},
        };
        app.delete('/api/org/teams/:teamId/meetings/:meetingId/attendance/subteams/:subteamPk',
            authenticateMiddleware([{"bindles":["corp:meetingsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.removeMeetingSubteam)),

            async function MeetingsController_removeMeetingSubteam(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_removeMeetingSubteam, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'removeMeetingSubteam',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 204,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_markAttendance: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
                userPk: {"in":"path","name":"userPk","required":true,"dataType":"double"},
                body: {"in":"body","name":"body","required":true,"ref":"APIMarkAttendanceRequest"},
        };
        app.patch('/api/org/teams/:teamId/meetings/:meetingId/attendance/:userPk',
            authenticateMiddleware([{"bindles":["corp:meetingsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.markAttendance)),

            async function MeetingsController_markAttendance(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_markAttendance, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'markAttendance',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsMeetingsController_removeMeetingAttendee: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                meetingId: {"in":"path","name":"meetingId","required":true,"dataType":"string"},
                userPk: {"in":"path","name":"userPk","required":true,"dataType":"double"},
        };
        app.delete('/api/org/teams/:teamId/meetings/:meetingId/attendance/:userPk',
            authenticateMiddleware([{"bindles":["corp:meetingsmgmt"]}]),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController)),
            ...(fetchMiddlewares<RequestHandler>(MeetingsController.prototype.removeMeetingAttendee)),

            async function MeetingsController_removeMeetingAttendee(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsMeetingsController_removeMeetingAttendee, request, response });

                const controller = new MeetingsController();

              await templateService.apiHandler({
                methodName: 'removeMeetingAttendee',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 204,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsHooksController_processGitRepoEventHook: Record<string, TsoaRoute.ParameterSchema> = {
                repoEvent: {"in":"body","name":"repoEvent","required":true,"ref":"GiteaHookRepositoryTrigger"},
        };
        app.post('/api/webhook/git/repoevent',
            ...(fetchMiddlewares<RequestHandler>(HooksController)),
            ...(fetchMiddlewares<RequestHandler>(HooksController.prototype.processGitRepoEventHook)),

            async function HooksController_processGitRepoEventHook(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsHooksController_processGitRepoEventHook, request, response });

                const controller = new HooksController();

              await templateService.apiHandler({
                methodName: 'processGitRepoEventHook',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsHooksController_processGitMainCommitEventHook: Record<string, TsoaRoute.ParameterSchema> = {
                commitEvent: {"in":"body","name":"commitEvent","required":true,"ref":"GiteaHookCommitTrigger"},
        };
        app.post('/api/webhook/git/commitevent',
            ...(fetchMiddlewares<RequestHandler>(HooksController)),
            ...(fetchMiddlewares<RequestHandler>(HooksController.prototype.processGitMainCommitEventHook)),

            async function HooksController_processGitMainCommitEventHook(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsHooksController_processGitMainCommitEventHook, request, response });

                const controller = new HooksController();

              await templateService.apiHandler({
                methodName: 'processGitMainCommitEventHook',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsEventController_getListOfEvents: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                options: {"in":"queries","name":"options","ref":"GetEventListOptions"},
        };
        app.get('/api/events',
            authenticateMiddleware([{"oidc":[]},{"ats_otp":[]}]),
            ...(fetchMiddlewares<RequestHandler>(EventController)),
            ...(fetchMiddlewares<RequestHandler>(EventController.prototype.getListOfEvents)),

            async function EventController_getListOfEvents(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsEventController_getListOfEvents, request, response });

                const controller = new EventController();

              await templateService.apiHandler({
                methodName: 'getListOfEvents',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsEventController_getEvent: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                eventId: {"in":"path","name":"eventId","required":true,"dataType":"string"},
        };
        app.get('/api/events/:eventId',
            authenticateMiddleware([{"oidc":[]},{"ats_otp":[]}]),
            ...(fetchMiddlewares<RequestHandler>(EventController)),
            ...(fetchMiddlewares<RequestHandler>(EventController.prototype.getEvent)),

            async function EventController_getEvent(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsEventController_getEvent, request, response });

                const controller = new EventController();

              await templateService.apiHandler({
                methodName: 'getEvent',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsEventController_createEvent: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                body: {"in":"body","name":"body","required":true,"ref":"CreateEventRequest"},
        };
        app.post('/api/events',
            authenticateMiddleware([{"events":[]}]),
            ...(fetchMiddlewares<RequestHandler>(EventController)),
            ...(fetchMiddlewares<RequestHandler>(EventController.prototype.createEvent)),

            async function EventController_createEvent(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsEventController_createEvent, request, response });

                const controller = new EventController();

              await templateService.apiHandler({
                methodName: 'createEvent',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsEventController_cancelEvent: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                eventId: {"in":"path","name":"eventId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","dataType":"nestedObjectLiteral","nestedProperties":{"notify":{"dataType":"boolean"}}},
        };
        app.delete('/api/events/:eventId',
            authenticateMiddleware([{"events":[]}]),
            ...(fetchMiddlewares<RequestHandler>(EventController)),
            ...(fetchMiddlewares<RequestHandler>(EventController.prototype.cancelEvent)),

            async function EventController_cancelEvent(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsEventController_cancelEvent, request, response });

                const controller = new EventController();

              await templateService.apiHandler({
                methodName: 'cancelEvent',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsEventController_updateEvent: Record<string, TsoaRoute.ParameterSchema> = {
                eventId: {"in":"path","name":"eventId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"UpdateEventRequest"},
        };
        app.patch('/api/events/:eventId',
            authenticateMiddleware([{"events":[]}]),
            ...(fetchMiddlewares<RequestHandler>(EventController)),
            ...(fetchMiddlewares<RequestHandler>(EventController.prototype.updateEvent)),

            async function EventController_updateEvent(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsEventController_updateEvent, request, response });

                const controller = new EventController();

              await templateService.apiHandler({
                methodName: 'updateEvent',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsEventController_getRsvps: Record<string, TsoaRoute.ParameterSchema> = {
                eventId: {"in":"path","name":"eventId","required":true,"dataType":"string"},
                queries: {"in":"queries","name":"queries","required":true,"ref":"GetRsvpsRequest"},
        };
        app.get('/api/events/:eventId/rsvps',
            authenticateMiddleware([{"events":[]}]),
            ...(fetchMiddlewares<RequestHandler>(EventController)),
            ...(fetchMiddlewares<RequestHandler>(EventController.prototype.getRsvps)),

            async function EventController_getRsvps(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsEventController_getRsvps, request, response });

                const controller = new EventController();

              await templateService.apiHandler({
                methodName: 'getRsvps',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsEventController_rsvpToEvent: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                eventId: {"in":"path","name":"eventId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"RsvpRequest"},
        };
        app.post('/api/events/:eventId/rsvp',
            authenticateMiddleware([{"ats_otp":[]},{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(EventController)),
            ...(fetchMiddlewares<RequestHandler>(EventController.prototype.rsvpToEvent)),

            async function EventController_rsvpToEvent(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsEventController_rsvpToEvent, request, response });

                const controller = new EventController();

              await templateService.apiHandler({
                methodName: 'rsvpToEvent',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsEventController_getRsvpForEvent: Record<string, TsoaRoute.ParameterSchema> = {
                eventId: {"in":"path","name":"eventId","required":true,"dataType":"string"},
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
        };
        app.get('/api/events/:eventId/rsvp',
            authenticateMiddleware([{"oidc":[]},{"ats_otp":[]}]),
            ...(fetchMiddlewares<RequestHandler>(EventController)),
            ...(fetchMiddlewares<RequestHandler>(EventController.prototype.getRsvpForEvent)),

            async function EventController_getRsvpForEvent(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsEventController_getRsvpForEvent, request, response });

                const controller = new EventController();

              await templateService.apiHandler({
                methodName: 'getRsvpForEvent',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsAuthController_getUserInfo: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
        };
        app.get('/api/auth/userinfo',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(AuthController)),
            ...(fetchMiddlewares<RequestHandler>(AuthController.prototype.getUserInfo)),

            async function AuthController_getUserInfo(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsAuthController_getUserInfo, request, response });

                const controller = new AuthController();

              await templateService.apiHandler({
                methodName: 'getUserInfo',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsAuthController_handleLogin: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                redirect_uri: {"in":"query","name":"redirect_uri","dataType":"string"},
                return_to: {"in":"query","name":"return_to","dataType":"string"},
                state: {"in":"query","name":"state","dataType":"string"},
        };
        app.get('/api/auth/login',
            ...(fetchMiddlewares<RequestHandler>(AuthController)),
            ...(fetchMiddlewares<RequestHandler>(AuthController.prototype.handleLogin)),

            async function AuthController_handleLogin(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsAuthController_handleLogin, request, response });

                const controller = new AuthController();

              await templateService.apiHandler({
                methodName: 'handleLogin',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 302,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsAuthController_handleRedirect: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
        };
        app.get('/api/auth/redirect',
            ...(fetchMiddlewares<RequestHandler>(AuthController)),
            ...(fetchMiddlewares<RequestHandler>(AuthController.prototype.handleRedirect)),

            async function AuthController_handleRedirect(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsAuthController_handleRedirect, request, response });

                const controller = new AuthController();

              await templateService.apiHandler({
                methodName: 'handleRedirect',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 302,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsAuthController_otpInitRequest: Record<string, TsoaRoute.ParameterSchema> = {
                body: {"in":"body","name":"body","required":true,"ref":"OtpInitRequest"},
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
        };
        app.post('/api/auth/otpinit',
            ...(fetchMiddlewares<RequestHandler>(AuthController)),
            ...(fetchMiddlewares<RequestHandler>(AuthController.prototype.otpInitRequest)),

            async function AuthController_otpInitRequest(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsAuthController_otpInitRequest, request, response });

                const controller = new AuthController();

              await templateService.apiHandler({
                methodName: 'otpInitRequest',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsAuthController_otpVerifyRequest: Record<string, TsoaRoute.ParameterSchema> = {
                body: {"in":"body","name":"body","required":true,"ref":"OtpVerifyRequest"},
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
        };
        app.post('/api/auth/otpverify',
            ...(fetchMiddlewares<RequestHandler>(AuthController)),
            ...(fetchMiddlewares<RequestHandler>(AuthController.prototype.otpVerifyRequest)),

            async function AuthController_otpVerifyRequest(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsAuthController_otpVerifyRequest, request, response });

                const controller = new AuthController();

              await templateService.apiHandler({
                methodName: 'otpVerifyRequest',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsAuthController_otpVerifySession: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
        };
        app.get('/api/auth/verifyotpsession',
            ...(fetchMiddlewares<RequestHandler>(AuthController)),
            ...(fetchMiddlewares<RequestHandler>(AuthController.prototype.otpVerifySession)),

            async function AuthController_otpVerifySession(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsAuthController_otpVerifySession, request, response });

                const controller = new AuthController();

              await templateService.apiHandler({
                methodName: 'otpVerifySession',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsAuthController_handleLogout: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
        };
        app.post('/api/auth/logout',
            ...(fetchMiddlewares<RequestHandler>(AuthController)),
            ...(fetchMiddlewares<RequestHandler>(AuthController.prototype.handleLogout)),

            async function AuthController_handleLogout(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsAuthController_handleLogout, request, response });

                const controller = new AuthController();

              await templateService.apiHandler({
                methodName: 'handleLogout',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getResumeUploadUrl: Record<string, TsoaRoute.ParameterSchema> = {
                request: {"in":"request","name":"request","required":true,"dataType":"object"},
                fileName: {"in":"query","name":"fileName","required":true,"dataType":"string"},
                contentType: {"in":"query","name":"contentType","required":true,"dataType":"string"},
        };
        app.get('/api/ats/resume/upload-url',
            authenticateMiddleware([{"ats_otp":[]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getResumeUploadUrl)),

            async function ATSController_getResumeUploadUrl(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getResumeUploadUrl, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getResumeUploadUrl',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getResumeDownloadUrl: Record<string, TsoaRoute.ParameterSchema> = {
                request: {"in":"request","name":"request","required":true,"dataType":"object"},
                key: {"in":"query","name":"key","required":true,"dataType":"string"},
        };
        app.get('/api/ats/resume/download',
            authenticateMiddleware([{"ats_otp":[]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getResumeDownloadUrl)),

            async function ATSController_getResumeDownloadUrl(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getResumeDownloadUrl, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getResumeDownloadUrl',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 307,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getSubTeamATSConfig: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/ats/config/:teamId',
            authenticateMiddleware([{"bindles":["corp:hiringaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getSubTeamATSConfig)),

            async function ATSController_getSubTeamATSConfig(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getSubTeamATSConfig, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getSubTeamATSConfig',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_createOrUpdateSubteamConfig: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"ATSSubteamConfigRequest"},
        };
        app.post('/api/ats/config/:teamId',
            authenticateMiddleware([{"bindles":["corp:hiringaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.createOrUpdateSubteamConfig)),

            async function ATSController_createOrUpdateSubteamConfig(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_createOrUpdateSubteamConfig, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'createOrUpdateSubteamConfig',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getAllRecruitingTeams: Record<string, TsoaRoute.ParameterSchema> = {
        };
        app.get('/api/ats/openteams',
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getAllRecruitingTeams)),

            async function ATSController_getAllRecruitingTeams(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getAllRecruitingTeams, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getAllRecruitingTeams',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getApplicationStages: Record<string, TsoaRoute.ParameterSchema> = {
        };
        app.get('/api/ats/stages',
            authenticateMiddleware([{"oidc":[]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getApplicationStages)),

            async function ATSController_getApplicationStages(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getApplicationStages, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getApplicationStages',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getTeamDetails: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/ats/openteams/:teamId',
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getTeamDetails)),

            async function ATSController_getTeamDetails(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getTeamDetails, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getTeamDetails',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getTeamApplications: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
        };
        app.get('/api/ats/applications/:teamId',
            authenticateMiddleware([{"bindles":["corp:hiringaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getTeamApplications)),

            async function ATSController_getTeamApplications(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getTeamApplications, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getTeamApplications',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getApplicationDetails: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                applicationId: {"in":"path","name":"applicationId","required":true,"dataType":"string"},
        };
        app.get('/api/ats/applications/:teamId/:applicationId/info',
            authenticateMiddleware([{"bindles":["corp:hiringaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getApplicationDetails)),

            async function ATSController_getApplicationDetails(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getApplicationDetails, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getApplicationDetails',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_updateApplicationFeedback: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                applicationId: {"in":"path","name":"applicationId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"dataType":"nestedObjectLiteral","nestedProperties":{"notes":{"dataType":"string"},"stars":{"dataType":"double"}}},
        };
        app.put('/api/ats/applications/:teamId/:applicationId/feedback',
            authenticateMiddleware([{"bindles":["corp:hiringaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.updateApplicationFeedback)),

            async function ATSController_updateApplicationFeedback(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_updateApplicationFeedback, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'updateApplicationFeedback',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getApplicantUrls: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                applicantId: {"in":"path","name":"applicantId","required":true,"dataType":"string"},
        };
        app.get('/api/ats/applications/:teamId/:applicantId/resume',
            authenticateMiddleware([{"bindles":["corp:hiringaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getApplicantUrls)),

            async function ATSController_getApplicantUrls(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getApplicantUrls, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getApplicantUrls',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_updateApplicationStage: Record<string, TsoaRoute.ParameterSchema> = {
                req: {"in":"request","name":"req","required":true,"dataType":"object"},
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                applicationId: {"in":"path","name":"applicationId","required":true,"dataType":"string"},
                body: {"in":"body","name":"body","required":true,"ref":"ATSUpdateApplicationStageRequest"},
        };
        app.put('/api/ats/applications/:teamId/:applicationId/stage',
            authenticateMiddleware([{"bindles":["corp:hiringaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.updateApplicationStage)),

            async function ATSController_updateApplicationStage(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_updateApplicationStage, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'updateApplicationStage',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_getApplicantApplications: Record<string, TsoaRoute.ParameterSchema> = {
                teamId: {"in":"path","name":"teamId","required":true,"dataType":"string"},
                applicantId: {"in":"path","name":"applicantId","required":true,"dataType":"string"},
        };
        app.get('/api/ats/applications/:teamId/:applicantId/otherapps',
            authenticateMiddleware([{"bindles":["corp:hiringaccess"]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.getApplicantApplications)),

            async function ATSController_getApplicantApplications(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_getApplicantApplications, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'getApplicantApplications',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_applyToTeam: Record<string, TsoaRoute.ParameterSchema> = {
                body: {"in":"body","name":"body","required":true,"ref":"ATSTeamApplicationRequest"},
                request: {"in":"request","name":"request","required":true,"dataType":"object"},
        };
        app.post('/api/ats/applications/apply',
            authenticateMiddleware([{"ats_otp":[]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.applyToTeam)),

            async function ATSController_applyToTeam(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_applyToTeam, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'applyToTeam',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 201,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        const argsATSController_updateProfile: Record<string, TsoaRoute.ParameterSchema> = {
                body: {"in":"body","name":"body","required":true,"ref":"ApplicantProfile"},
                request: {"in":"request","name":"request","required":true,"dataType":"object"},
        };
        app.post('/api/ats/profile',
            authenticateMiddleware([{"ats_otp":[]}]),
            ...(fetchMiddlewares<RequestHandler>(ATSController)),
            ...(fetchMiddlewares<RequestHandler>(ATSController.prototype.updateProfile)),

            async function ATSController_updateProfile(request: ExRequest, response: ExResponse, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            let validatedArgs: any[] = [];
            try {
                validatedArgs = templateService.getValidatedArgs({ args: argsATSController_updateProfile, request, response });

                const controller = new ATSController();

              await templateService.apiHandler({
                methodName: 'updateProfile',
                controller,
                response,
                next,
                validatedArgs,
                successStatus: 200,
              });
            } catch (err) {
                return next(err);
            }
        });
        // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa


    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

    function authenticateMiddleware(security: TsoaRoute.Security[] = []) {
        return async function runAuthenticationMiddleware(request: any, response: any, next: any) {

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            // keep track of failed auth attempts so we can hand back the most
            // recent one.  This behavior was previously existing so preserving it
            // here
            const failedAttempts: any[] = [];
            const pushAndRethrow = (error: any) => {
                failedAttempts.push(error);
                throw error;
            };

            const secMethodOrPromises: Promise<any>[] = [];
            for (const secMethod of security) {
                if (Object.keys(secMethod).length > 1) {
                    const secMethodAndPromises: Promise<any>[] = [];

                    for (const name in secMethod) {
                        secMethodAndPromises.push(
                            expressAuthenticationRecasted(request, name, secMethod[name], response)
                                .catch(pushAndRethrow)
                        );
                    }

                    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

                    secMethodOrPromises.push(Promise.all(secMethodAndPromises)
                        .then(users => { return users[0]; }));
                } else {
                    for (const name in secMethod) {
                        secMethodOrPromises.push(
                            expressAuthenticationRecasted(request, name, secMethod[name], response)
                                .catch(pushAndRethrow)
                        );
                    }
                }
            }

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa

            try {
                request['user'] = await Promise.any(secMethodOrPromises);

                // Response was sent in middleware, abort
                if (response.writableEnded) {
                    return;
                }

                next();
            }
            catch(err) {
                // Show most recent error as response
                const error = failedAttempts.pop();
                error.status = error.status || 401;

                // Response was sent in middleware, abort
                if (response.writableEnded) {
                    return;
                }
                next(error);
            }

            // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
        }
    }

    // WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
}

// WARNING: This file was auto-generated with tsoa. Please do not modify it. Re-run tsoa to re-generate this file: https://github.com/lukeautry/tsoa
