const LINKEDIN_PROFILE_HOSTS = new Set(["linkedin.com", "www.linkedin.com"]);
const LINKEDIN_PROFILE_PATH = /^\/in\/([^/]+)\/?$/i;

/**
 * Validates and normalizes an optional LinkedIn profile URL.
 * Returns an empty string for a blank value and null for an invalid value.
 */
export function normalizeLinkedInProfileUrl(value: string | null | undefined): string | null {
    /* OrgController calls this with body.linkedinUrl whenever it is not
       undefined, so a JSON body carrying an explicit null reaches here and
       used to throw a TypeError, turning a bad request into a 500. Treat any
       non-string the way blank input is treated: the field is being cleared. */
    if (typeof value !== "string") return "";

    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.length > 300) return null;

    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;

    try {
        const url = new URL(candidate);
        const pathMatch = url.pathname.match(LINKEDIN_PROFILE_PATH);

        if (
            url.protocol !== "https:" ||
            !LINKEDIN_PROFILE_HOSTS.has(url.hostname.toLowerCase()) ||
            url.username ||
            url.password ||
            url.port ||
            !pathMatch
        ) {
            return null;
        }

        return `https://www.linkedin.com/in/${pathMatch[1]}`;
    } catch {
        return null;
    }
}
