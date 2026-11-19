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

import { SharedResourceClient } from ".."
import { BindlePermissionMap } from "../../controllers/BindleController"
import { GetGroupInfoResponse } from "../AuthentikClient/models"

export class PeoplePortalClient implements SharedResourceClient {
    public static readonly TAG = "PeoplePortalClient"
    private readonly supportedBindles: BindlePermissionMap = {
        "corp:awsaccess": {
            friendlyName: "AWS Console Access",
            description: "Enabling this allows members in this subteam to access the AWS Console",
        },

        "corp:hiringaccess": {
            friendlyName: "Permit Recruitment",
            description: "Enabling this allows members in this subteam to recruit new members to your team",
        },

        "corp:bindlesync": {
            friendlyName: "Enable Permissions Sync",
            description: "Enabling this allows members to sync shared permissions",
        },

        "corp:rootsettings": {
            friendlyName: "Allow Team Settings Management",
            description: "Enabling this allows members in this subteam to modify team settings",
        },

        "corp:subteamaccess": {
            friendlyName: "Allow Subteam Management",
            description: "Enabling this allows members in this subteam to create, modify and delete subteams",
        },

        "corp:permissionsmgmt": {
            friendlyName: "Allow Permission Management",
            description: "Enabling this allows members to modify all permissions for all subteams",
        },

        "corp:membermgmt": {
            friendlyName: "Allow Member Management",
            description: "Enabling this allows people in this subteam to add & remove members to your team",
        },

        "corp:reviewaccess": {
            friendlyName: "Allow Internal Review Access",
            description: "Enabling this allows people in this subteam to write internal reviews on other members of this team.",
        },

        "corp:meetingsmgmt": {
            friendlyName: "Allow Meeting Management",
            description: "Enabling this allows members in this subteam to create, modify and delete team meetings",
        },

        "corp:eventmgmt": {
            friendlyName: "Allow Event Management",
            description: "Enabling this allows members in this subteam to create, modify, and delete events"
        },
    }

    async init(): Promise<void> {
        return Promise.resolve()
    }

    getResourceName(): string {
        return PeoplePortalClient.TAG
    }

    getSupportedBindles(): BindlePermissionMap {
        return this.supportedBindles;
    }

    /**
     * PeoplePortalClient provides the ability to set granular permissions. Bindle Sync
     * is redundant as permission settings happen in subteam configurations and evaluations
     * happen in BindleController.ts and the Bindle Authentication Middleware.
     * 
     * @param org Team Information from Authentik
     * @param callback Notify Client of Sync Status (Not Needed)
     * @returns True (Always)
     */
    handleOrgBindleSync(org: GetGroupInfoResponse, callback: (updatedResourceCount: number, status: string) => void): Promise<boolean> {
        return Promise.resolve(true);
    }

    /**
     * PeoplePortalClient only defines permission metadata and owns no external
     * resource state, so there is nothing to archive.
     */
    archiveTeam(org: GetGroupInfoResponse, callback: (updatedResourceCount: number, status: string) => void): Promise<boolean> {
        return Promise.resolve(true);
    }
}