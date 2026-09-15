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

import { createHash } from "crypto";
import { TeamInformationDetail, UserInformationPartial } from "../clients/AuthentikClient/models";

export type ProjectCatalogRepositorySnapshotStatus = "verified" | "unconfigured" | "unavailable";

export interface ProjectCatalogRepository {
    /** Stable Gitea repository ID. */
    id: number;
    /** Gitea repository name within the owning organization. */
    slug: string;
    fullName: string;
    url?: string;
    archived: boolean;
}

export interface ProjectCatalogRepositorySnapshot {
    status: ProjectCatalogRepositorySnapshotStatus;
    repositories: ProjectCatalogRepository[];
    /** Internal source projection used to join project leads by exact email. */
    memberStatus: ProjectCatalogRepositorySnapshotStatus;
    members: ProjectCatalogGiteaMemberReference[];
}

export interface ProjectCatalogLeadReference {
    /** Canonical People Portal person key when the Authentik provider ID is available. */
    id?: string;
    /** Provider that issued providerId. */
    provider: "authentik";
    /** Stable Authentik user PK; retained for downstream joins when available. */
    providerId?: string;
    username: string;
    name: string;
    /** Lowercase, trimmed SSO/People Portal email when present. */
    email?: string;
    role: string;
    /** Gitea identity matched only by a unique normalized email. */
    gitea?: ProjectCatalogGiteaIdentity;
}

export interface ProjectCatalogGiteaIdentity {
    provider: "gitea";
    /** Stable Gitea user ID. */
    providerId: string;
    username: string;
    /** Lowercase, trimmed Gitea member email when present. */
    email?: string;
}

/** Raw Gitea member projection retained for identity-quality validation. */
export interface ProjectCatalogGiteaMemberReference {
    provider: "gitea";
    providerId?: string;
    username?: string;
    email?: string;
}

export type ProjectCatalogIdentityIssueCode =
    | "missing-email"
    | "duplicate-email"
    | "missing-provider-id"
    | "duplicate-provider-id";

export interface ProjectCatalogIdentityIssue {
    code: ProjectCatalogIdentityIssueCode;
    provider: "authentik" | "gitea";
    projectIds: string[];
    personIds: string[];
    email?: string;
}

export interface ProjectCatalogOwningTeam {
    /** Stable Authentik team PK. */
    id: string;
    /** Authentik team.name, which is also the Shared Resource ID. */
    slug: string;
    /** Authentik team.attributes.friendlyName for UI display. */
    displayName: string;
}

export interface ProjectCatalogGitSource {
    provider: "gitea";
    /**
     * People Portal provisions a Gitea organization with the Authentik root
     * team's technical name. This is a namespace convention, not an
     * assertion that the organization currently exists.
     */
    organization: string;
    organizationSource: "people-portal-team-name";
    repositorySnapshot: ProjectCatalogRepositorySnapshotStatus;
    /** Whether the organization's member roster was verified for identity joins. */
    memberSnapshot: ProjectCatalogRepositorySnapshotStatus;
    repositories: ProjectCatalogRepository[];
}

export interface ProjectCatalogRevision {
    /** Content hash of the source projection; excludes request observation time. */
    value: string;
    effectiveFrom?: string;
    effectiveTo?: string;
    observedAt: Date;
}

export interface ProjectCatalogSowMetadata {
    reference?: string;
    title?: string;
    effectiveFrom?: string;
    effectiveTo?: string;
}

export interface ProjectCatalogEntry {
    /** Authentik team.pk; stable UID for the life of the project team. */
    id: string;
    /** Authentik team.name; Shared Resource ID and Gitea organization namespace. */
    slug: string;
    /** Authentik team.attributes.friendlyName for UI display. */
    displayName: string;
    owningTeam: ProjectCatalogOwningTeam;
    leads: ProjectCatalogLeadReference[];
    gitea: ProjectCatalogGitSource;
    /** Present only when a future authoritative SOW source is available. */
    sow?: ProjectCatalogSowMetadata;
    revision: ProjectCatalogRevision;
}

export interface APIProjectCatalogOptions {
    /** Include teams with archivedAt or flaggedForDeletion set. */
    includeArchived?: boolean;
}

export interface ProjectCatalogResponse {
    observedAt: Date;
    projects: ProjectCatalogEntry[];
    /** Identity data-quality findings; consumers must not infer around them. */
    identityIssues: ProjectCatalogIdentityIssue[];
}

function normalizedEmail(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const email = value.trim().toLowerCase();
    return email || undefined;
}

function explicitLeadRole(user: UserInformationPartial, teamPk: string): string | undefined {
    const role = user.attributes?.roles?.[teamPk];
    if (typeof role !== "string" || !/\b(?:lead|owner)\b/i.test(role)) {
        return undefined;
    }

    return role;
}

function giteaIdentityByEmail(
    email: string | undefined,
    members: ProjectCatalogGiteaMemberReference[],
): ProjectCatalogGiteaIdentity | undefined {
    if (!email) {
        return undefined;
    }

    const matches = members.filter((member) => normalizedEmail(member.email) === email);
    if (matches.length !== 1) {
        return undefined;
    }

    const member = matches[0];
    if (!member) {
        return undefined;
    }
    const providerId = typeof member.providerId === "string" && member.providerId.trim()
        ? member.providerId.trim()
        : undefined;
    const username = typeof member.username === "string" && member.username.trim()
        ? member.username.trim()
        : undefined;
    if (!providerId || !username) {
        return undefined;
    }

    const memberEmail = normalizedEmail(member.email);

    return {
        provider: "gitea",
        providerId,
        username,
        ...(memberEmail ? { email: memberEmail } : {}),
    };
}

function leadReferences(
    team: TeamInformationDetail,
    memberSnapshot: ProjectCatalogRepositorySnapshot,
): ProjectCatalogLeadReference[] {
    return team.users
        .flatMap((user) => {
            const role = explicitLeadRole(user, team.pk);
            const providerId = typeof user.pk === "string" && user.pk.trim() ? user.pk.trim() : undefined;
            const email = normalizedEmail(user.email);
            if (!role) {
                return [];
            }

            const gitea = memberSnapshot.memberStatus === "verified"
                ? giteaIdentityByEmail(email, memberSnapshot.members)
                : undefined;

            const lead: ProjectCatalogLeadReference = {
                provider: "authentik",
                username: user.username,
                name: user.name,
                ...(providerId ? { id: providerId, providerId } : {}),
                ...(email ? { email } : {}),
                role,
                ...(gitea ? { gitea } : {}),
            };
            return [lead];
        })
        .sort((left, right) =>
            (left.id ?? left.email ?? left.username).localeCompare(right.id ?? right.email ?? right.username));
}

/**
 * Validate the exact person join keys exposed by the catalog.
 *
 * The same Authentik person may lead multiple projects, so repeated
 * providerId/email pairs are valid. A key is an issue only when it is missing
 * or maps to more than one provider identity. No name or username fallback is
 * used.
 */
export function projectCatalogIdentityIssues(
    teams: TeamInformationDetail[],
    snapshotsByProject?: ReadonlyMap<string, ProjectCatalogRepositorySnapshot>,
): ProjectCatalogIdentityIssue[] {
    const emailToIdentities = new Map<string, { personIds: Set<string>; projectIds: Set<string> }>();
    const providerIdToEmails = new Map<string, { emails: Set<string>; projectIds: Set<string> }>();
    const giteaEmailToProviderIds = new Map<string, { personIds: Set<string>; projectIds: Set<string> }>();
    const giteaProviderIdToEmails = new Map<string, { emails: Set<string>; projectIds: Set<string> }>();
    const issues: ProjectCatalogIdentityIssue[] = [];

    for (const team of teams) {
        for (const user of team.users) {
            if (!explicitLeadRole(user, team.pk)) {
                continue;
            }

            const providerId = typeof user.pk === "string" && user.pk.trim() ? user.pk.trim() : undefined;
            const email = normalizedEmail(user.email);
            if (!providerId) {
                issues.push({
                    code: "missing-provider-id",
                    provider: "authentik",
                    projectIds: [team.pk],
                    personIds: [],
                });
                continue;
            }
            if (!email) {
                issues.push({
                    code: "missing-email",
                    provider: "authentik",
                    projectIds: [team.pk],
                    personIds: [providerId],
                });
            } else {
                const emailEntry = emailToIdentities.get(email) ?? {
                    personIds: new Set<string>(),
                    projectIds: new Set<string>(),
                };
                emailEntry.personIds.add(providerId);
                emailEntry.projectIds.add(team.pk);
                emailToIdentities.set(email, emailEntry);
            }

            const providerEntry = providerIdToEmails.get(providerId) ?? {
                emails: new Set<string>(),
                projectIds: new Set<string>(),
            };
            if (email) {
                providerEntry.emails.add(email);
            }
            providerEntry.projectIds.add(team.pk);
            providerIdToEmails.set(providerId, providerEntry);
        }

        const repositorySnapshot = snapshotsByProject?.get(team.pk);
        if (repositorySnapshot?.memberStatus !== "verified") {
            continue;
        }

        for (const member of repositorySnapshot.members) {
            const providerId = typeof member.providerId === "string" && member.providerId.trim()
                ? member.providerId.trim()
                : undefined;
            const email = normalizedEmail(member.email);
            if (!providerId) {
                issues.push({
                    code: "missing-provider-id",
                    provider: "gitea",
                    projectIds: [team.pk],
                    personIds: [],
                    ...(email ? { email } : {}),
                });
            }
            if (!email) {
                issues.push({
                    code: "missing-email",
                    provider: "gitea",
                    projectIds: [team.pk],
                    personIds: providerId ? [providerId] : [],
                });
            }

            if (email) {
                const emailEntry = giteaEmailToProviderIds.get(email) ?? {
                    personIds: new Set<string>(),
                    projectIds: new Set<string>(),
                };
                if (providerId) {
                    emailEntry.personIds.add(providerId);
                }
                emailEntry.projectIds.add(team.pk);
                giteaEmailToProviderIds.set(email, emailEntry);
            }

            if (providerId) {
                const providerEntry = giteaProviderIdToEmails.get(providerId) ?? {
                    emails: new Set<string>(),
                    projectIds: new Set<string>(),
                };
                if (email) {
                    providerEntry.emails.add(email);
                }
                providerEntry.projectIds.add(team.pk);
                giteaProviderIdToEmails.set(providerId, providerEntry);
            }
        }
    }

    for (const [email, value] of emailToIdentities) {
        if (value.personIds.size > 1) {
            issues.push({
                code: "duplicate-email",
                provider: "authentik",
                projectIds: [...value.projectIds].sort(),
                personIds: [...value.personIds].sort(),
                email,
            });
        }
    }
    for (const [providerId, value] of providerIdToEmails) {
        if (value.emails.size > 1) {
            issues.push({
                code: "duplicate-provider-id",
                provider: "authentik",
                projectIds: [...value.projectIds].sort(),
                personIds: [providerId],
            });
        }
    }
    for (const [email, value] of giteaEmailToProviderIds) {
        if (value.personIds.size > 1) {
            issues.push({
                code: "duplicate-email",
                provider: "gitea",
                projectIds: [...value.projectIds].sort(),
                personIds: [...value.personIds].sort(),
                email,
            });
        }
    }
    for (const [providerId, value] of giteaProviderIdToEmails) {
        if (value.emails.size > 1) {
            issues.push({
                code: "duplicate-provider-id",
                provider: "gitea",
                projectIds: [...value.projectIds].sort(),
                personIds: [providerId],
            });
        }
    }

    return issues.sort((left, right) =>
        left.code.localeCompare(right.code) ||
        left.projectIds.join(",").localeCompare(right.projectIds.join(",")) ||
        left.personIds.join(",").localeCompare(right.personIds.join(",")) ||
        (left.email ?? "").localeCompare(right.email ?? ""));
}

function revisionValue(
    team: TeamInformationDetail,
    leads: ProjectCatalogLeadReference[],
    gitea: ProjectCatalogGitSource,
): string {
    const sourceProjection = {
        projectId: team.pk,
        projectSlug: team.name,
        displayName: team.friendlyName,
        teamType: team.teamType,
        seasonType: team.seasonType,
        seasonYear: team.seasonYear,
        effectiveFrom: team.teamStartDate,
        effectiveTo: team.teamEndDate,
        archivedAt: team.archivedAt,
        flaggedForDeletion: team.flaggedForDeletion,
        leads,
        gitea: {
            organization: gitea.organization,
            repositorySnapshot: gitea.repositorySnapshot,
            memberSnapshot: gitea.memberSnapshot,
            repositories: gitea.repositories,
        },
    };

    return createHash("sha256")
        .update(JSON.stringify(sourceProjection))
        .digest("hex");
}

export function createProjectCatalogEntry(
    team: TeamInformationDetail,
    repositorySnapshot: ProjectCatalogRepositorySnapshot,
    observedAt: Date = new Date(),
): ProjectCatalogEntry {
    const leads = leadReferences(team, repositorySnapshot);
    const gitea: ProjectCatalogGitSource = {
        provider: "gitea",
        organization: team.name,
        organizationSource: "people-portal-team-name",
        repositorySnapshot: repositorySnapshot.status,
        memberSnapshot: repositorySnapshot.memberStatus,
        repositories: [...repositorySnapshot.repositories].sort((left, right) =>
            left.id - right.id || left.slug.localeCompare(right.slug)),
    };

    return {
        id: team.pk,
        slug: team.name,
        displayName: team.friendlyName,
        owningTeam: {
            id: team.pk,
            slug: team.name,
            displayName: team.friendlyName,
        },
        leads,
        gitea,
        revision: {
            value: revisionValue(team, leads, gitea),
            ...(team.teamStartDate && { effectiveFrom: team.teamStartDate }),
            ...(team.teamEndDate && { effectiveTo: team.teamEndDate }),
            observedAt,
        },
    };
}
