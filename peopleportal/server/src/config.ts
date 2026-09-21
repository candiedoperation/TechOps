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

import { GiteaClient } from "./clients/GiteaClient";
import { SlackClient } from "./clients/SlackClient";
import { RootTeamSettingClient, SharedResourceClient } from "./clients";
import { AWSClient } from "./clients/AWSClient";
import { AppleAccountClient } from "./clients/AppleAccountClient";
import { PeoplePortalClient } from "./clients/PeoplePortalClient";
import { EnabledBindlePermissions } from "./controllers/BindleController";
import { TeamType } from "./clients/AuthentikClient/models";
import { DiscordClient } from "./clients/DiscordClient";

/**
 * This interface helps define the default configuration that needs to be applied
 * when a team of a specific type is created. This configuration involves the list
 * of default subteams and the default bindle permissions to apply to each subteam.
 */
export interface TeamTypeConfig {
  defaultSubteams: {
    friendlyName: string;
    description: string;
    bindles?: { [key: string]: EnabledBindlePermissions }; /* Optional Bindle Permissions */
  }[];
}

/**
 * This interface helps define the configuration for service teams.
 * Service teams are teams that are unique to the organization and are created
 * automatically by People Portal if they don't exist.
 * 
 * Some service teams enable hardcoded internal functionality. For example, the
 * ExecutiveBoard team integrates with the Executive Authorization Layer to override
 * all bindles just as how superusers would do.
 * 
 * Adding to and removing members from these service teams have predefined rulesets
 * that are defined in the code.
 */
export interface ServiceTeamConfig {
  friendlyName: string;
  description: string;
  subteams: {
    uniqueName: string;
    friendlyName: string;
    description: string;
    bindles?: { [key: string]: EnabledBindlePermissions };
  }[];
}

/* Define Enabled Shared Resources Here */
export const ENABLED_SHARED_RESOURCES: { [key: string]: SharedResourceClient } = {
  // appleAccountClient: new AppleAccountClient(),
  giteaClient: new GiteaClient(),
  peoplePortalClient: new PeoplePortalClient(),
  slackClient: new SlackClient(),
  discordClient: new DiscordClient(),
}

/* Define Enabled Root Team Setting Resources Here */
export const ENABLED_TEAMSETTING_RESOURCES: { [key: string]: RootTeamSettingClient } = {
  awsClient: new AWSClient()
}

/* Define Enabled Service Teams Here */
export const ENABLED_SERVICE_TEAMS: Record<string, ServiceTeamConfig> = {
  ExecutiveBoard: {
    friendlyName: "Executive Board",
    description: "The President and Other Club Executives",
    subteams: [
      {
        uniqueName: "ExecutiveBoardMembers",
        friendlyName: "Current Executives",
        description: "The Current President and Club Executives"
      },
      {
        uniqueName: "ExecutiveBoardAlumni",
        friendlyName: "Previous Executives",
        description: "The Previous Presidents and Club Executives"
      },
    ]
  },
  TechOps: {
    friendlyName: "Technical Operations",
    description: "The Team Responsible for People Portal and Club Infrastructure",
    subteams: [
      {
        uniqueName: "TechOpsMembers",
        friendlyName: "Current Tech Ops",
        description: "The Current Technical Operations Team"
      },
      {
        uniqueName: "TechOpsAlumni",
        friendlyName: "Previous Tech Ops",
        description: "The Previous Technical Operations Team"
      },
    ]
  },
  Events: {
    friendlyName: "Events",
    description: "Team of Members able to Create, Manage, and Delete Events",
    subteams: [
      {
        uniqueName: "EventsTeamMembers",
        friendlyName: "Events Team Members",
        description: "Current members of the events team.",
        bindles: {
          "PeoplePortalClient": {
            "corp:eventmgmt": true,
          },
        }
      },
    ]
  },
}

/* Define Team Type Templates Here */
export const TEAM_TYPE_CONFIGS: Partial<Record<TeamType, TeamTypeConfig>> = {
  [TeamType.PROJECT]: {
    defaultSubteams: [
      {
        friendlyName: "Leadership",
        description: "Project and Tech Leads",
        bindles: {
          "PeoplePortalClient": {
            "corp:awsaccess": true,
            "corp:hiringaccess": true
          },

          "SlackClient": {
            "slack:universalaccess": true,
          },

          "GiteaClient": {
            "repo:allowcreate": true,
            "repo:brprotect-approvals": true,
            "repo:brprotect-override": true,
            "repo:brprotect-merge": true
          },
        }
      },
      {
        friendlyName: "Engineering",
        description: "UI/UX, PMs, SWEs, etc.",
        bindles: {
          "GiteaClient": {
            "repo:brprotect-override": true,
            "repo:brprotect-merge": true
          },
        }
      }
    ]
  },

  [TeamType.BOOTCAMP]: {
    defaultSubteams: [
      {
        friendlyName: "Learners",
        description: "Bootcamp Students",
        bindles: {
          "GiteaClient": {
            "repo:allowcreate": true,
            "repo:brprotect-override": true,
            "repo:brprotect-merge": true,
            "repo:brprotect-approvals": true
          },
        }
      },
      {
        friendlyName: "Educators",
        description: "Bootcamp Teachers",
        bindles: {
          "PeoplePortalClient": {
            "corp:hiringaccess": true,
            "corp:bindlesync": true,
            "corp:subteamaccess": true,
            "corp:membermgmt": true
          },

          "SlackClient": {
            "slack:universalaccess": true,
          },

          "GiteaClient": {
            "repo:allowcreate": true,
            "repo:brprotect-override": true,
            "repo:brprotect-merge": true,
            "repo:brprotect-approvals": true
          },
        }
      },
      {
        friendlyName: "Interviewers",
        description: "Interviewers for Bootcamp",
        bindles: {
          "PeoplePortalClient": {
            "corp:hiringaccess": true
          }
        }
      }
    ]
  }
}

/**
 * Root teams under which administrative authority can be held.
 *
 * A named set rather than a string literal because the check appeared in five
 * places across auth.ts and EventController, and a sixth would have been easy
 * to miss.
 */
export const ADMIN_AUTHORITY_TEAMS: ReadonlySet<string> = new Set([
  "ExecutiveBoard",
  "TechOps",
]);

/**
 * The subteams that actually confer it.
 *
 * Root membership alone is not enough, because getRootTeamsForUsername
 * collapses every subteam to its parent: a member of ExecutiveBoardAlumni
 * resolves to ExecutiveBoard exactly like a current executive does. Checking
 * only the root therefore granted past executives full override on every team
 * for as long as they stayed in the alumni group.
 *
 * Membership is read from the user's own groups, so "Previous Executives" and
 * "Previous Tech Ops" are records of who used to hold the role, not a way to
 * keep it. Add a subteam here to grant authority through it.
 */
export const ADMIN_AUTHORITY_SUBTEAMS: ReadonlySet<string> = new Set([
  "ExecutiveBoardMembers",
  "TechOpsMembers",
]);

/**
 * Whether a user holds organisation-wide administrative authority.
 *
 * Both halves must hold: an admin root team that is not flagged for deletion,
 * and direct membership of either that root team or one of the admin subteams.
 *
 * @param rootTeams  from AuthentikClient.getRootTeamsForUsername
 * @param userGroups the user's own group names, from the OIDC session
 */
export const hasAdminAuthority = (
  rootTeams: { name: string; flaggedForDeletion?: boolean }[],
  userGroups: string[]
): boolean => {
  const liveAdminRoot = rootTeams.some(
    team => ADMIN_AUTHORITY_TEAMS.has(team.name) && !team.flaggedForDeletion
  );
  if (!liveAdminRoot) return false;

  return userGroups.some(
    group => ADMIN_AUTHORITY_SUBTEAMS.has(group) || ADMIN_AUTHORITY_TEAMS.has(group)
  );
};
