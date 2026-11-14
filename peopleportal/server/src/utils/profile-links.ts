export type ProfileLinkKind = "linkedin" | "github";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

function isLinkedInHost(hostname: string): boolean {
    return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

/**
 * Checks that an applicant profile link is an https URL on the expected host.
 * LinkedIn accepts linkedin.com and any of its subdomains; GitHub accepts
 * github.com and www.github.com only.
 */
export function isAllowedProfileLink(
    value: string | null | undefined,
    kind: ProfileLinkKind,
): boolean {
    if (typeof value !== "string") return false;

    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 500) return false;

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return false;
    }

    if (url.protocol !== "https:" || url.username || url.password || url.port) {
        return false;
    }

    const hostname = url.hostname.toLowerCase();
    return kind === "linkedin"
        ? isLinkedInHost(hostname)
        : GITHUB_HOSTS.has(hostname);
}
