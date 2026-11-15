import ExecutionEnvironment from "@docusaurus/ExecutionEnvironment";

// This runs on every page load before React hydrates
if (ExecutionEnvironment.canUseDOM) {
    // Function to sync Docusaurus theme with Shadcn
    function syncTheme() {
        const root = document.documentElement;
        // Check data-theme first, then localStorage, then default to light
        const theme =
            root.getAttribute("data-theme") ||
            localStorage.getItem("theme") ||
            "light";

        // Remove both classes first
        root.classList.remove("light", "dark");

        // Add the current theme class
        root.classList.add(theme);

        // Ensure data-theme is also set if missing (e.g. initial load from localStorage)
        if (!root.getAttribute("data-theme") && theme) {
            root.setAttribute("data-theme", theme);
        }
    }

    // Apply immediately
    syncTheme();

    // Apply again after a slight delay to ensure we beat various hydration stages
    setTimeout(syncTheme, 0);
    setTimeout(syncTheme, 50);

    // Watch for theme changes via MutationObserver
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (
                mutation.type === "attributes" &&
                mutation.attributeName === "data-theme"
            ) {
                syncTheme();
            }
        });
    });

    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
    });
}

// Export onRouteDidUpdate to force sync on navigation
export function onRouteDidUpdate({ location, previousLocation }) {
    if (
        ExecutionEnvironment.canUseDOM &&
        location.pathname !== previousLocation?.pathname
    ) {
        // Apply immediately and then again after a small delay to handle Docusaurus re-renders
        const currentTheme =
            document.documentElement.getAttribute("data-theme") ||
            localStorage.getItem("theme") ||
            "light";

        // Helper to apply
        const apply = () => {
            document.documentElement.classList.remove("light", "dark");
            document.documentElement.classList.add(currentTheme);
        };

        apply();
        setTimeout(apply, 0);
        setTimeout(apply, 50);
        requestAnimationFrame(apply);
    }
}
