import process from "process";

const PHOTO_CHECK_URL = process.env.PHOTO_CHECK_URL || "http://localhost:8001";

/* This check fails OPEN by default: if the sidecar is down, slow, or returns
   something unexpected, the upload is allowed. That is the shipped behaviour and
   it is kept as the default so a sidecar outage cannot block every avatar
   upload. It does mean stopping the sidecar silently disables face checking, so
   set PHOTO_CHECK_FAIL_CLOSED=true to reject uploads the service could not rule
   on, and alert on the warnings below either way. */
/* Off by default. The sidecar that answers these calls is added to the
   deployment by PeoplePortalDeploy PR #1, which is not merged, so on a deploy
   today there is nothing on PHOTO_CHECK_URL. Rather than call a service that
   is not there and fail open on every upload, the check announces that it is
   switched off. Set PHOTO_CHECK_ENABLED=true once the sidecar ships. */
const ENABLED = process.env.PHOTO_CHECK_ENABLED === "true";

const FAIL_CLOSED = process.env.PHOTO_CHECK_FAIL_CLOSED === "true";

function undecided(reason: string): PhotoCheckResult {
    console.warn(
        `[photo-check] no decision (${reason}); ${FAIL_CLOSED ? "rejecting" : "ALLOWING"} upload`
    );
    return { passed: !FAIL_CLOSED, reason };
}

export interface PhotoCheckResult {
    passed: boolean;
    reason: string;
    count?: number;
}

export async function checkPhotoHasFace(imageBytes: Uint8Array): Promise<PhotoCheckResult> {
    if (!ENABLED) {
        /* Deliberately silent: this is a configured-off state, not a failure,
           and warning on every upload would train people to ignore the log. */
        return { passed: true, reason: "check_disabled" };
    }

    const formData = new FormData();
    const blob = new Blob([imageBytes]);
    formData.append("file", blob, "upload");

    try {
        const response = await fetch(`${PHOTO_CHECK_URL}/check-photo`, {
            method: "POST",
            body: formData,
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            console.error(`Photo check service returned ${response.status}`);
            return undecided("service_error");
        }

        const payload = (await response.json()) as Partial<PhotoCheckResult>;
        // Only an explicit rejection from the service may block an upload.
        // Missing or malformed decision fields fail open by design.
        if (typeof payload.passed !== "boolean") {
            return undecided("malformed_response");
        }
        const result: PhotoCheckResult = {
            passed: payload.passed,
            reason: payload.reason ?? "ok",
        };
        if (typeof payload.count === "number") {
            result.count = payload.count;
        }
        return result;
    } catch (e) {
        console.error("Photo check service unreachable:", e);
        return undecided("service_unavailable");
    }
}
