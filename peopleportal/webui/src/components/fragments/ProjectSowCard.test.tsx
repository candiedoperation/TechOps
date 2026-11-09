import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSowCard } from "./ProjectSowCard";
import { checkSowFile } from "@/lib/sow";

const UPLOADED = {
    sow: {
        sowId: "s1",
        fileName: "studybuddy-sow.pdf",
        uploadedBy: 101,
        uploadedByName: "Jane Lead",
        uploadedAt: "2026-09-02T15:00:00.000Z",
        downloadUrl: "https://s3.example.invalid/sow.pdf?signed=1",
    },
    canUpload: false,
    canDelete: false,
};
const EMPTY_LEAD = { sow: null, canUpload: true, canDelete: false };
const EMPTY_MEMBER = { sow: null, canUpload: false, canDelete: false };

type Reply = { status: number; body: unknown };
const json = (status: number, body: unknown): Reply => ({ status, body });

/** Answers each server call from a queue keyed by "METHOD path-suffix". */
function mockServer(routes: Record<string, Reply[]>) {
    const calls: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            const method = init?.method ?? "GET";
            const suffix = url.endsWith("/upload-url")
                ? "upload-url"
                : url.endsWith("/confirm")
                  ? "confirm"
                  : "sow";
            const route = `${method} ${suffix}`;
            calls.push(route);
            const queue = routes[route];
            const reply = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
            if (!reply) throw new Error(`unexpected ${route}`);
            return {
                ok: reply.status >= 200 && reply.status < 300,
                status: reply.status,
                json: async () => reply.body,
            };
        }),
    );
    return calls;
}

const pdf = (name = "sow.pdf", size = 1000) =>
    new File([new Uint8Array(size)], name, { type: "application/pdf" });

beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("ProjectSowCard", () => {
    it("shows the file, uploader, date and a download link once uploaded", async () => {
        mockServer({ "GET sow": [json(200, UPLOADED)] });
        render(<ProjectSowCard projectPk="p1" />);

        await waitFor(() =>
            expect(screen.getByText("studybuddy-sow.pdf")).toBeInTheDocument(),
        );
        expect(screen.getByText(/Uploaded by Jane Lead on/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute(
            "href",
            UPLOADED.sow.downloadUrl,
        );
        expect(screen.queryByRole("button", { name: /Upload SOW/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    });

    it("offers the upload button to leadership when there is no SOW", async () => {
        mockServer({ "GET sow": [json(200, EMPTY_LEAD)] });
        render(<ProjectSowCard projectPk="p1" />);
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: /Upload SOW/ }),
            ).toBeInTheDocument(),
        );
    });

    it("tells other members leadership will upload it", async () => {
        mockServer({ "GET sow": [json(200, EMPTY_MEMBER)] });
        render(<ProjectSowCard projectPk="p1" />);
        await waitFor(() =>
            expect(
                screen.getByText(/leadership\s+uploads it/),
            ).toBeInTheDocument(),
        );
        expect(screen.queryByRole("button", { name: /Upload SOW/ })).toBeNull();
    });

    it("uploads, shows progress, then shows the saved SOW", async () => {
        const calls = mockServer({
            "GET sow": [json(200, EMPTY_LEAD), json(200, UPLOADED)],
            "POST upload-url": [
                json(200, { uploadUrl: "https://s3.example.invalid", fields: { key: "k" } }),
            ],
            "POST confirm": [json(201, UPLOADED.sow)],
        });
        let finish!: () => void;
        const uploader = vi.fn(
            (_url: string, _fields: Record<string, string>, _file: File, onProgress: (p: number) => void) =>
                new Promise<void>((resolve) => {
                    onProgress(40);
                    finish = resolve;
                }),
        );
        render(<ProjectSowCard projectPk="p1" uploadToStorage={uploader} />);
        await screen.findByRole("button", { name: /Upload SOW/ });

        await userEvent.upload(screen.getByTestId("sow-file-input"), pdf());

        await waitFor(() =>
            expect(screen.getByText("Uploading… 40%")).toBeInTheDocument(),
        );
        expect(uploader).toHaveBeenCalledWith(
            "https://s3.example.invalid",
            { key: "k" },
            expect.any(File),
            expect.any(Function),
        );

        finish();
        await waitFor(() =>
            expect(screen.getByText("studybuddy-sow.pdf")).toBeInTheDocument(),
        );
        expect(calls).toEqual(["GET sow", "POST upload-url", "POST confirm", "GET sow"]);
    });

    it("shows the server's message when the file fails the signature check", async () => {
        mockServer({
            "GET sow": [json(200, EMPTY_LEAD)],
            "POST upload-url": [json(200, { uploadUrl: "u", fields: {} })],
            "POST confirm": [json(400, { message: "The file is not a real PDF file" })],
        });
        render(<ProjectSowCard projectPk="p1" uploadToStorage={async () => {}} />);
        await screen.findByRole("button", { name: /Upload SOW/ });

        await userEvent.upload(screen.getByTestId("sow-file-input"), pdf());

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "The file is not a real PDF file",
        );
        expect(screen.getByRole("button", { name: /Upload SOW/ })).toBeInTheDocument();
    });

    it("shows the 409 message when a SOW already exists", async () => {
        mockServer({
            "GET sow": [json(200, EMPTY_LEAD)],
            "POST upload-url": [
                json(409, { message: "This project already has a SOW for this semester." }),
            ],
        });
        render(<ProjectSowCard projectPk="p1" />);
        await screen.findByRole("button", { name: /Upload SOW/ });
        await userEvent.upload(screen.getByTestId("sow-file-input"), pdf());
        expect(await screen.findByRole("alert")).toHaveTextContent(/already has a SOW/);
    });

    it("lets an executive delete the SOW", async () => {
        const calls = mockServer({
            "GET sow": [json(200, { ...UPLOADED, canDelete: true }), json(200, EMPTY_LEAD)],
            "DELETE sow": [json(204, {})],
        });
        render(<ProjectSowCard projectPk="p1" />);
        await userEvent.click(await screen.findByRole("button", { name: /Delete/ }));
        await screen.findByRole("button", { name: /Upload SOW/ });
        expect(calls).toContain("DELETE sow");
    });

    it("shows an error when the SOW cannot be loaded", async () => {
        mockServer({ "GET sow": [json(403, { message: "Only project members can view the SOW" })] });
        render(<ProjectSowCard projectPk="p1" />);
        expect(
            await screen.findByText("Only project members can view the SOW"),
        ).toBeInTheDocument();
    });
});

describe("checkSowFile", () => {
    it("allows PDF and DOCX up to 15 MB only", () => {
        expect(checkSowFile(pdf("a.pdf"))).toBeNull();
        expect(checkSowFile(pdf("a.DOCX"))).toBeNull();
        expect(checkSowFile(pdf("a.png"))).toMatch(/PDF or DOCX/);
        expect(checkSowFile(pdf("a.pdf", 0))).toMatch(/empty/);
        expect(checkSowFile(pdf("a.pdf", 15 * 1024 * 1024 + 1))).toMatch(/15 MB/);
    });
});
