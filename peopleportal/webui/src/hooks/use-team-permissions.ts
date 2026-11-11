/**
  People Portal UI
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

import * as React from "react";
import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config";

interface TeamPermissionsResponse {
    unrestricted: boolean;
    bindles: string[];
}

/**
 * Tells the UI which bindles the current user holds on a team, so controls the
 * server would refuse can be disabled up front. Informational only; the server
 * still enforces every action. While loading, or if the lookup fails, nothing
 * is permitted, so controls default to disabled.
 *
 * @param teamId Team or Subteam ID to resolve permissions for
 */
export function useTeamPermissions(teamId?: string) {
    const [permissions, setPermissions] =
        React.useState<TeamPermissionsResponse | null>(null);

    React.useEffect(() => {
        setPermissions(null);
        if (!teamId) return;

        let cancelled = false;
        fetch(
            `${PEOPLEPORTAL_SERVER_ENDPOINT}/api/org/teams/${teamId}/permissions`,
            { credentials: "include" },
        )
            .then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return (await r.json()) as TeamPermissionsResponse;
            })
            .then((data) => {
                if (!cancelled) setPermissions(data);
            })
            .catch(() => {
                /* Unknown permissions stay null, so everything remains disabled */
            });

        return () => {
            cancelled = true;
        };
    }, [teamId]);

    const can = React.useCallback(
        (bindle: string) =>
            permissions !== null &&
            (permissions.unrestricted || permissions.bindles.includes(bindle)),
        [permissions],
    );

    return { can, isLoading: permissions === null };
}
