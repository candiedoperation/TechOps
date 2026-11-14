import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PermissionGuard, NO_PERMISSION_MESSAGE } from "./PermissionGuard";
import { useTeamPermissions } from "@/hooks/use-team-permissions";
import { Button } from "../ui/button";

const mockPermissions = (
    body: { unrestricted: boolean; bindles: string[] } | "fail" | "pending",
) =>
    vi.stubGlobal(
        "fetch",
        vi.fn(() =>
            body === "pending"
                ? new Promise(() => {})
                : body === "fail"
                  ? Promise.resolve({ ok: false, status: 500 })
                  : Promise.resolve({ ok: true, json: async () => body }),
        ),
    );

/* A control gated the way DashboardTeamInfo does it */
const Harness = (props: { onAction: () => void }) => {
    const { can } = useTeamPermissions("team-1");
    return (
        <PermissionGuard allowed={can("corp:membermgmt")}>
            <Button onClick={props.onAction}>Add Members</Button>
        </PermissionGuard>
    );
};

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
    mockPermissions("pending");
    /* Radix tooltips measure themselves on hover; jsdom has no ResizeObserver */
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});

describe("PermissionGuard", () => {
    it("enables the control for a user holding the bindle and fires the action", async () => {
        mockPermissions({ unrestricted: false, bindles: ["corp:membermgmt"] });
        const onAction = vi.fn();
        render(<Harness onAction={onAction} />);

        const control = () =>
            screen.getByRole("button", { name: "Add Members" });
        await waitFor(() => expect(control()).toBeEnabled());
        await userEvent.setup().click(control());

        expect(onAction).toHaveBeenCalledTimes(1);
    });

    it("enables the control for an unrestricted user (owner or executive)", async () => {
        mockPermissions({ unrestricted: true, bindles: [] });
        render(<Harness onAction={vi.fn()} />);

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Add Members" }),
            ).toBeEnabled(),
        );
    });

    it("greys out the control for a user without the bindle and fires nothing", async () => {
        mockPermissions({
            unrestricted: false,
            bindles: ["corp:hiringaccess"],
        });
        const onAction = vi.fn();
        render(<Harness onAction={onAction} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        const button = screen.getByRole("button", { name: "Add Members" });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("aria-disabled", "true");
        expect(button.parentElement).toHaveAttribute(
            "title",
            NO_PERMISSION_MESSAGE,
        );

        await userEvent.setup().click(button);
        expect(onAction).not.toHaveBeenCalled();
    });

    it("stays disabled while permissions are still loading", () => {
        mockPermissions("pending");
        const onAction = vi.fn();
        render(<Harness onAction={onAction} />);

        const button = screen.getByRole("button", { name: "Add Members" });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("aria-disabled", "true");
    });

    it("stays disabled when the permissions lookup fails", async () => {
        mockPermissions("fail");
        render(<Harness onAction={vi.fn()} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());

        expect(
            screen.getByRole("button", { name: "Add Members" }),
        ).toBeDisabled();
    });
});
