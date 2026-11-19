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

import { Controller, Get, Route, SuccessResponse, Tags } from "tsoa";
import { SharedResourceClient } from "../clients";
import { ENABLED_SHARED_RESOURCES } from "../config";

import { GetGroupInfoResponse } from "../clients/AuthentikClient/models";
import { PeoplePortalClient } from "../clients/PeoplePortalClient";

export interface EnabledBindlePermissions {
    /* Name of the Perm (ex. repo:allowcreate) */
    [key: string]: boolean
}

export interface BindlePermissionMap {
    [key: string]: BindlePermission
}

export interface BindlePermission {
    friendlyName: string,
    description: string,
}

@Route("/api/bindles")
export class BindleController extends Controller {
    private static bindleDefinition: { [key: string]: BindlePermissionMap } = (() => {
        const definitions: { [key: string]: BindlePermissionMap } = {};
        for (const sharedResource of Object.values(ENABLED_SHARED_RESOURCES)) {
            const resourceName = sharedResource.getResourceName();
            definitions[resourceName] = sharedResource.getSupportedBindles();
        }

        /* Perform Return for Static Store */
        return definitions;
    })();

    /**
     * Fetches the list of globally available Bindle Settings constructed
     * from enabled shared resources.
     * 
     * @returns List of available Bindle Permissions
     */
    @Get("definitions")
    @Tags("Bindle Authorization Layer")
    @SuccessResponse(200)
    async getDefinitions(): Promise<{ [key: string]: BindlePermissionMap }> {
        return BindleController.bindleDefinition;
    }

    /**
     * Given a list of bindle permissions, this function will sanitize the input
     * by removing any bindle permissions that are not supported by the enabled
     * shared resources.
     * 
     * @param bindlePermissions Input Bindle Permission Map
     * @returns Sanitized Bindle Permission Map
     */
    public static sanitizeBindlePermissions = (bindlePermissions: { [key: string]: EnabledBindlePermissions }): { [key: string]: EnabledBindlePermissions } => {
        const sanitizedBindlePermissions: { [key: string]: EnabledBindlePermissions } = {};
        for (const clientName in bindlePermissions) {
            const supportedBindles = BindleController.bindleDefinition[clientName];
            if (!supportedBindles)
                continue;

            const filteredBindles: EnabledBindlePermissions = {};
            for (const bindleKey in bindlePermissions[clientName]) {
                // Check if this bindle key is supported by the client
                if (!supportedBindles[bindleKey])
                    continue;

                /* Update Filtered Bindle Setting */
                filteredBindles[bindleKey] = bindlePermissions[clientName][bindleKey] ?? false;
            }

            /* Apply the Filtered Bindles to the Final List */
            sanitizedBindlePermissions[clientName] = filteredBindles;
        }

        return sanitizedBindlePermissions;
    }

    /**
     * Calculates granular permissions from subteam memberships interactively.
     * Team Owners bypass this check in the middleware. Scoped to People Portal
     * bindles only.
     * 
     * @param targetTeam Team Information from Authentik Client
     * @param userGroups User's group membership from OIDC Session
     * @returns Set of Bindle Permissions (Ex. corp:membermgmt)
     */
    public static getEffectivePermissionSet(targetTeam: GetGroupInfoResponse, userGroups: string[]): Set<string> {
        /* Add Group Structures to a Set for O(1) lookup, takes O(n) time */
        const activePermissions = new Set<string>();
        const userGroupSet = new Set(userGroups);

        /* 1. Iterate through Subteams */
        if (targetTeam.subteams) {
            for (const subteam of targetTeam.subteams) {
                /* 2. Check if user is in this subteam */
                if (userGroupSet.has(subteam.name)) {
                    /* 3. Merge Enabled Bindles (PeoplePortal Only) */
                    const bindlePermissions = subteam.attributes.bindlePermissions;
                    if (bindlePermissions) {
                        const clientBindles = bindlePermissions[PeoplePortalClient.TAG];
                        if (clientBindles) {
                            for (const [bindle, enabled] of Object.entries(clientBindles)) {
                                if (enabled) activePermissions.add(bindle);
                            }
                        }
                    }
                }
            }
        }

        return activePermissions;
    }
}