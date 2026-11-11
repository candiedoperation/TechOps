import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { EventAttendance } from "./EventAttendance";

/* Regression tests for the All RSVPs list: a late response must never
   replace the page that is currently selected. */

const EVENT_ID = "evt1";

const EVENT = {
    _id: EVENT_ID,
    eventName: "Meeting",
    eventDescription: "TechOps Meeting",
    /* Far future so RSVPs stay open. */
    startTime: "2099-01-01T17:30:00.000Z",
    endTime: "2099-01-01T18:30:00.000Z",
    location: "IRB",
    scope: "internal",
    marketingChannels: [],
};

const rsvpRow = (page: number, i: number) => ({
    _id: `p${page}-${i}`,
    eventId: EVENT_ID,
    email: `page${page}-${i}@test.dev`,
    status: "Accept",
});

const PAGES: Record<string, ReturnType<typeof rsvpRow>[]> = {
    "1": [rsvpRow(1, 1), rsvpRow(1, 2)],
    "2": [rsvpRow(2, 1), rsvpRow(2, 2)],
};

const MY_RSVP = {
    _id: "mine",
    eventId: EVENT_ID,
    email: "akadmin@example.invalid",
    status: "Accept",
    updatedAt: "2026-11-11T12:00:00.000Z",
};

/* A promise the test resolves by hand, to hold a request "in flight". */
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
};

const jsonResponse = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
});

/* Every GET /rsvps page requested, in order. */
let listPagesRequested: string[];
let submitted: boolean;
/* When set, the POST /rsvp or a given list page waits for this before answering. */
let holdSubmit: ReturnType<typeof deferred> | null;
let holdListPage: { page: string; gate: ReturnType<typeof deferred> } | null;

const fakeFetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const method = init?.method ?? "GET";

    if (url.pathname === `/api/events/${EVENT_ID}`) {
        return jsonResponse({ data: EVENT });
    }

    if (url.pathname === `/api/events/${EVENT_ID}/rsvp`) {
        if (method === "POST") {
            if (holdSubmit) await holdSubmit.promise;
            submitted = true;
            return jsonResponse({ status: "Success", issues: [] }, 201);
        }
        return jsonResponse({ rsvp: submitted ? MY_RSVP : null });
    }

    if (url.pathname === `/api/events/${EVENT_ID}/rsvps`) {
        const page = url.searchParams.get("page") ?? "1";
        listPagesRequested.push(page);
        if (holdListPage && holdListPage.page === page) {
            const { gate } = holdListPage;
            holdListPage = null; // only hold this one request
            await gate.promise;
        }
        return jsonResponse({
            status: "success",
            data: PAGES[page] ?? [],
            pagination: { totalPages: 2 },
        });
    }

    throw new Error(`Unexpected fetch: ${method} ${input}`);
});

const renderPage = () =>
    render(
        <MemoryRouter
            initialEntries={[`/community/events/${EVENT_ID}/attendance`]}
        >
            <Routes>
                <Route
                    path="/community/events/:eventId/attendance"
                    element={<EventAttendance />}
                />
            </Routes>
        </MemoryRouter>,
    );

const clickPage = async (n: number) => {
    await userEvent.click(screen.getByRole("link", { name: String(n) }));
};

beforeEach(() => {
    listPagesRequested = [];
    submitted = false;
    holdSubmit = null;
    holdListPage = null;
    fakeFetch.mockClear();
    vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EventAttendance All RSVPs list", () => {
    it("refreshes the current page when a delayed RSVP submit finishes after a page change", async () => {
        renderPage();
        expect(await screen.findByText("page1-1@test.dev")).toBeInTheDocument();

        // Start a submit that won't finish until we say so.
        holdSubmit = deferred();
        await userEvent.click(
            screen.getByRole("button", { name: "Submit RSVP" }),
        );

        // Change to page 2 while the submit is still pending.
        await clickPage(2);
        expect(await screen.findByText("page2-1@test.dev")).toBeInTheDocument();
        const requestsBeforeSubmitFinished = listPagesRequested.length;

        // Let the submit finish; it should refresh the list.
        holdSubmit.resolve();
        await waitFor(() =>
            expect(listPagesRequested.length).toBeGreaterThan(
                requestsBeforeSubmitFinished,
            ),
        );

        // The refresh must use the page that is selected now (2), not 1.
        expect(listPagesRequested.at(-1)).toBe("2");
        await waitFor(() =>
            expect(screen.getByText("page2-1@test.dev")).toBeInTheDocument(),
        );
        expect(screen.queryByText("page1-1@test.dev")).not.toBeInTheDocument();
    });

    it("ignores an older list response that arrives after a newer page loaded", async () => {
        const user = userEvent.setup();
        renderPage();
        expect(await screen.findByText("page1-1@test.dev")).toBeInTheDocument();

        await user.click(screen.getByRole("link", { name: "2" }));
        expect(await screen.findByText("page2-1@test.dev")).toBeInTheDocument();

        // Go back to page 1, but hold its response.
        const gate = deferred();
        holdListPage = { page: "1", gate };
        await user.click(screen.getByRole("link", { name: "1" }));
        await waitFor(() => expect(listPagesRequested.at(-1)).toBe("1"));

        // Switch to page 2 again; this newer request answers right away.
        await user.click(screen.getByRole("link", { name: "2" }));
        await waitFor(() => expect(listPagesRequested.at(-1)).toBe("2"));
        expect(await screen.findByText("page2-1@test.dev")).toBeInTheDocument();

        // Now the old page 1 response arrives late. It must be ignored.
        gate.resolve();
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.getByText("page2-1@test.dev")).toBeInTheDocument();
        expect(screen.queryByText("page1-1@test.dev")).not.toBeInTheDocument();
    });
});
