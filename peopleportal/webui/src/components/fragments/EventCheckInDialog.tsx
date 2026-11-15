import { useRef, useState, type FormEvent } from "react";
import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
    eventId: string;
    eventName: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCheckedIn: (checkedInAt: string) => void;
}

export function EventCheckInDialog({
    eventId,
    eventName,
    open,
    onOpenChange,
    onCheckedIn,
}: Props) {
    const [code, setCode] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [checkedInAt, setCheckedInAt] = useState<string | null>(null);
    const submitting = useRef(false);

    function handleOpenChange(nextOpen: boolean) {
        // Keep the dialog open until the request finishes.
        if (submitting.current) return;

        if (!nextOpen) {
            setCode("");
            setError(null);
            setCheckedInAt(null);
        }

        onOpenChange(nextOpen);
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const normalizedCode = code.trim();
        if (!normalizedCode || submitting.current) return;

        submitting.current = true;
        setPending(true);
        setError(null);

        try {
            const response = await fetch(
                `${PEOPLEPORTAL_SERVER_ENDPOINT}/api/events/${encodeURIComponent(eventId)}/check-in`,
                {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ code: normalizedCode }),
                },
            );

            const body = await response.json().catch(() => null);

            if (!response.ok) {
                const fallback =
                    response.status === 401
                        ? "Your session expired. Sign in and try again."
                        : response.status === 429
                          ? "Too many attempts. Wait a moment and try again."
                          : "Unable to check in. Please try again.";

                throw new Error(
                    typeof body?.message === "string"
                        ? body.message
                        : fallback,
                );
            }

            if (
                typeof body?.checkedInAt !== "string" ||
                Number.isNaN(Date.parse(body.checkedInAt))
            ) {
                throw new Error(
                    "We couldn't confirm your check-in. Please try again.",
                );
            }

            setCheckedInAt(body.checkedInAt);
            onCheckedIn(body.checkedInAt);
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : "Unable to connect. Please try again.",
            );
        } finally {
            submitting.current = false;
            setPending(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {checkedInAt ? "You're checked in!" : "Event check-in"}
                    </DialogTitle>
                    <DialogDescription>
                        Event: {eventName}
                    </DialogDescription>
                </DialogHeader>

                {checkedInAt ? (
                    <div className="space-y-4">
                        <p role="status" className="text-sm">
                            Your attendance was recorded at{" "}
                            {new Date(checkedInAt).toLocaleString()}.
                        </p>

                        <Button
                            className="w-full"
                            onClick={() => handleOpenChange(false)}
                        >
                            Done
                        </Button>
                    </div>
                ) : (
                    <form onSubmit={submit} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="event-check-in-code">
                                Event code
                            </Label>
                            <Input
                                id="event-check-in-code"
                                value={code}
                                onChange={(event) =>
                                    setCode(event.target.value)
                                }
                                placeholder="Enter the displayed event code"
                                autoComplete="off"
                                autoCapitalize="characters"
                                spellCheck={false}
                                disabled={pending}
                                aria-invalid={Boolean(error)}
                                aria-describedby={
                                    error ? "event-check-in-error" : undefined
                                }
                                required
                            />
                        </div>

                        {error && (
                            <p
                                id="event-check-in-error"
                                role="alert"
                                className="text-sm text-destructive"
                            >
                                {error}
                            </p>
                        )}

                        <Button
                            type="submit"
                            className="w-full"
                            disabled={pending || !code.trim()}
                        >
                            {pending ? "Checking in…" : "Check in"}
                        </Button>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}