import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardTeamRecruitment } from "./DashboardTeamRecuitment";
import type { RecruitmentApplication, RecruitmentDetails } from "./recruitment-queries";

const basePath = "/org/teams/team-a/recruitment";
const apiPath = "/api/ats/applications/team-a";
const makeApplication = (id: string): RecruitmentApplication => ({
    id, applicantId: `person-${id}`, name: `Applicant ${id.toUpperCase()}`,
    stage: "Applied", appliedAt: "2026-09-01", stars: 0,
    rolePreferences: [{ role: "Backend", subteamPk: "backend" }],
});

function deferred<T>() {
    let resolve: (value: T) => void = () => { throw new Error("Deferred not initialized"); };
    const promise = new Promise<T>(complete => { resolve = complete; });
    return { promise, resolve };
}

let applications: RecruitmentApplication[];
let details: Map<string, RecruitmentDetails>;
let requests: { path: string; signal: AbortSignal | null | undefined }[];
let responses: Map<string, Promise<Response>>;

beforeEach(() => {
    applications = [makeApplication("a"), makeApplication("b")];
    details = new Map(applications.map(application => [application.id, {
        ...application, email: `${application.id}@example.invalid`,
        profile: { whyAppDev: `Background ${application.id}` }, responses: {}, notes: `Notes ${application.id}`,
    }]));
    requests = [];
    responses = new Map();
    // Fake HTTP is the boundary; the router, query client, dialogs are real.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        requests.push({ path, signal: init?.signal });
        const response = responses.get(path);
        if (response) return response;
        if (path === "/api/org/teams/team-a") {
            return Response.json({ team: { attributes: { friendlyName: "Test Team", seasonType: "Fall", seasonYear: 2026 } }, subteams: [] });
        }
        if (path === "/api/ats/stages") return Response.json(["Applied", "Interview", "Rejected", "Potential Hire", "Hired"].map(id => ({ id, name: id })));
        if (path === apiPath) return Response.json(applications);
        for (const application of applications) {
            if (path === `${apiPath}/${application.id}/info`) return Response.json(details.get(application.id));
            if (path === `${apiPath}/${application.applicantId}/resume`) return Response.json({ resumeUrl: `https://example.invalid/${application.id}.pdf` });
            if (path === `${apiPath}/${application.applicantId}/otherapps`) return Response.json([]);
        }
        return Response.json({ message: "Unavailable" }, { status: 404 });
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function openBoard(search = "") {
    const router = createMemoryRouter([{ path: "/org/teams/:teamId/recruitment", element: <DashboardTeamRecruitment reviewerId={42} /> }], {
        initialEntries: [basePath + search],
    });
    const view = render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    return { router, ...view };
}

async function openA() {
    await userEvent.click(await screen.findByText("Applicant A"));
    await screen.findByText("Background a");
    await screen.findByRole("link", { name: /Open resume/ });
}

describe("recruitment review", () => {

    it("uses URL selection, browser history and cached data without losing other parameters", async () => {
        const { router } = openBoard("?filter=interview");
        await openA();
        expect(router.state.location.search).toBe("?filter=interview&application=a");
        await userEvent.click(screen.getByRole("button", { name: "Next applicant" }));
        await screen.findByText("Background b");
        expect(router.state.location.search).toContain("application=b");
        await act(() => router.navigate(-1));
        expect(screen.getByText("Background a")).toBeInTheDocument();
        expect(screen.getByTitle("Resume")).toHaveAttribute("src", "https://example.invalid/a.pdf");
        await act(() => router.navigate(1));
        expect(screen.getByText("Background b")).toBeInTheDocument();
        expect(requests.filter(request => request.path === `${apiPath}/a/info`)).toHaveLength(1);
        expect(requests.filter(request => request.path === `${apiPath}/person-a/resume`)).toHaveLength(1);
        expect(requests.filter(request => request.path === `${apiPath}/person-a/otherapps`)).toHaveLength(1);
        await userEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(router.state.location.search).toBe("?filter=interview");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("ignores late responses from the previous applicant, even if transport ignores cancellation", async () => {
        const slowDetails = deferred<Response>();
        const slowResume = deferred<Response>();
        const slowHistory = deferred<Response>();
        responses.set(`${apiPath}/a/info`, slowDetails.promise);
        responses.set(`${apiPath}/person-a/resume`, slowResume.promise);
        responses.set(`${apiPath}/person-a/otherapps`, slowHistory.promise);
        openBoard();
        await userEvent.click(await screen.findByText("Applicant A"));
        expect(screen.getByText("Loading other applications…")).toBeInTheDocument();
        expect(screen.queryByText("No other applications found.")).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Next applicant" }));
        await screen.findByText("Background b");
        await screen.findByRole("link", { name: /Open resume/ });
        expect(requests.find(request => request.path === `${apiPath}/a/info`)?.signal?.aborted).toBe(true);
        await act(async () => {
            slowDetails.resolve(Response.json(details.get("a")));
            slowResume.resolve(Response.json({ resumeUrl: "https://example.invalid/a.pdf" }));
            slowHistory.resolve(Response.json([{ id: "other", teamName: "A's other team", stage: "Applied", appliedAt: "2026-09-01" }]));
        });
        expect(screen.getByRole("heading", { name: "Applicant B" })).toBeInTheDocument();
        expect(screen.getByText("Background b")).toBeInTheDocument();
        expect(screen.queryByText("Background a")).not.toBeInTheDocument();
        expect(screen.queryByText("A's other team")).not.toBeInTheDocument();
        expect(screen.getByTitle("Resume")).toHaveAttribute("src", "https://example.invalid/b.pdf");
    });

});
