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

import { ENABLED_SERVICE_TEAMS } from "../config";

/* Function to Get All Reserved Team Names */
const getReservedTeamNames = (): Set<string> => {
    const reservedNames = new Set<string>();

    for (const serviceTeamName in ENABLED_SERVICE_TEAMS) {
        reservedNames.add(serviceTeamName);

        const config = ENABLED_SERVICE_TEAMS[serviceTeamName];
        if (config && config.subteams) {
            config.subteams.forEach(subteam => {
                reservedNames.add(subteam.uniqueName);
            });
        }
    }

    return reservedNames;
}

/* Define Flattened Set of Service Teams */
export const ENABLED_SERVICE_TEAM_NAMES: Set<string> = getReservedTeamNames();