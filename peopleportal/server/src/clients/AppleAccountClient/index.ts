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

export class AppleAccountClient implements SharedResourceClient {
    private static readonly TAG = "AppleAccountClient"
    private readonly supportedBindles: BindlePermissionMap = {
        "apple:platformaccess": {
            friendlyName: "App Store Connect Access",
            description: "Enabling this allows TestFlight and Publishing to the App Store",
        },
    }

    async init(): Promise<void> {
        return Promise.resolve()
    }

    getResourceName(): string {
        return AppleAccountClient.TAG;
    }

    getSupportedBindles(): BindlePermissionMap {
        return this.supportedBindles;
    }

    handleOrgBindleSync(org: GetGroupInfoResponse, callback: (updatedResourceCount: number, status: string) => void): Promise<boolean> {
        // TODO: Implement Apple Account Client
        return Promise.resolve(true);
    }

    archiveTeam(org: GetGroupInfoResponse, callback: (updatedResourceCount: number, status: string) => void): Promise<boolean> {
        // TODO: Implement Apple Account Client archival
        return Promise.resolve(true);
    }
}