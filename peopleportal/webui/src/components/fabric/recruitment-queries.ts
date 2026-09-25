import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config";

/** Application summary returned by the recruitment board endpoint. */
export interface RecruitmentApplication {
    id: string;
    name: string;
    stage: string;
    applicantId: string;
    rolePreferences: { role: string; subteamPk: string }[];
    appliedAt: string;
    stars: number;
    [key: string]: unknown;
}

/** Application information returned by the detail endpoint. */
export interface RecruitmentDetails extends RecruitmentApplication {
    email: string;
    profile: Record<string, string>;
    responses: Record<string, string>;
    hiredSubteamPk?: string;
    hiredRole?: string;
    appDevInternalPk?: number;
    notes?: string;
    stageHistory?: { stage: string; changedAt: string; changedBy?: string }[];
}

interface OtherApplication {
    id: string;
    teamName: string;
    stage: string;
    appliedAt: string;
}

/** Extra fields required by the existing stage-transition endpoints. */
export interface StageFields {
    interviewLink?: string;
    interviewGuidelines?: string;
    hiredRole?: string;
    hiredSubteamPk?: string;
}

const metadataFreshness = 60_000;
// The server signs URLs for 900 seconds. Refresh a minute early, including while open.
const resumeFreshness = 14 * 60_000;
const keys = {
    applications: (teamId: string) => ["recruitment", teamId, "applications"] as const,
    details: (teamId: string, id: string) => ["recruitment", teamId, "details", id] as const,
    resume: (teamId: string, id: string) => ["recruitment", teamId, "resume", id] as const,
    history: (teamId: string) => ["recruitment", teamId, "history"] as const,
};

// This HTTP boundary rejects failures because TanStack Query uses rejection for error state.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/${path}`, {
        ...init,
        credentials: "include",
    });
    if (!response.ok) {
        const message = response.status === 401 || response.status === 403
            ? "You no longer have access to this recruitment data."
            : response.status === 404
                ? "Application not found or unavailable for this team."
                : "Could not load or save recruitment data. Please try again.";
        throw new Error(message);
    }
    return response.json();
}

/** Owns identity-keyed review data and mutation invalidation for a single team. */
export function useRecruitmentQueries(teamId: string, selectedId: string | null) {
    const client = useQueryClient();
    const applications = useQuery({
        queryKey: keys.applications(teamId),
        queryFn: ({ signal }) => request<RecruitmentApplication[]>(`applications/${teamId}`, { signal }),
        staleTime: metadataFreshness,
    });
    const selected = applications.data?.find(application => application.id === selectedId);
    const details = useQuery({
        queryKey: keys.details(teamId, selectedId ?? ""),
        queryFn: ({ signal }) => request<RecruitmentDetails>(`applications/${teamId}/${encodeURIComponent(selectedId ?? "")}/info`, { signal }),
        enabled: selectedId !== null,
        staleTime: metadataFreshness,
    });
    const applicantId = selected?.applicantId ?? details.data?.applicantId;
    const resume = useQuery({
        queryKey: keys.resume(teamId, applicantId ?? ""),
        queryFn: async ({ signal }) => {
            const refreshAt = Date.now() + resumeFreshness;
            const result = await request<{ resumeUrl?: string }>(`applications/${teamId}/${applicantId}/resume`, { signal });
            if (!result.resumeUrl) throw new Error("Resume unavailable.");
            return { resumeUrl: result.resumeUrl, refreshAt };
        },
        enabled: applicantId !== undefined,
        staleTime: resumeFreshness,
        gcTime: resumeFreshness,
        refetchInterval: query => query.state.status === "error" ? false
            : Math.max(1_000, (query.state.data?.refreshAt ?? Date.now() + resumeFreshness) - Date.now()),
    });
    const history = useQuery({
        queryKey: [...keys.history(teamId), applicantId],
        queryFn: ({ signal }) => request<OtherApplication[]>(`applications/${teamId}/${applicantId}/otherapps`, { signal }),
        enabled: applicantId !== undefined,
        staleTime: metadataFreshness,
    });

    async function refreshApplication(applicationId: string) {
        // An initial detail read may predate the save; do not reuse its response.
        await client.cancelQueries({ queryKey: keys.details(teamId, applicationId) });
        await Promise.all([
            client.invalidateQueries({ queryKey: keys.applications(teamId) }),
            client.invalidateQueries({ queryKey: keys.details(teamId, applicationId) }),
        ]);
    }

    const feedback = useMutation({
        mutationKey: ["recruitment", teamId, "feedback", selectedId],
        mutationFn: ({ applicationId, ...body }: { applicationId: string; stars?: number; notes?: string }) =>
            request<unknown>(`applications/${teamId}/${applicationId}/feedback`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
        // Writes to one application stay ordered without blocking another applicant.
        scope: { id: `recruitment-feedback-${teamId}-${selectedId}` },
        onSettled: (_result, _error, { applicationId }) => refreshApplication(applicationId),
    });
    const isFeedbackPending = useIsMutating({ mutationKey: ["recruitment", teamId, "feedback", selectedId] }) > 0;
    const stage = useMutation({
        mutationFn: ({ applicationId, stage, ...fields }: StageFields & { applicationId: string; stage: string }) =>
            request<unknown>(`applications/${teamId}/${applicationId}/stage`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ stage, ...fields }),
            }),
        onSettled: (_result, _error, { applicationId }) => Promise.all([
            refreshApplication(applicationId),
            client.invalidateQueries({ queryKey: keys.history(teamId) }),
        ]),
    });

    return {
        applications, details, resume, history, feedback, isFeedbackPending, stage,
        selected: selected ?? details.data ?? null,
    };
}
