import React, { useLayoutEffect } from "react";
import { useColorMode } from "@docusaurus/theme-common";

/**
 * Component that syncs Docusaurus's colorMode with Shadcn's dark class
 * Uses useLayoutEffect to apply theme synchronously before paint to prevent flash
 */
export function ThemeSync({ children }: { children: React.ReactNode }) {
    const { colorMode } = useColorMode();

    // Use useLayoutEffect instead of useEffect to apply theme BEFORE browser paint
    // This prevents the flash of light theme on page load and navigation
    useLayoutEffect(() => {
        const root = window.document.documentElement;

        // Remove both classes first
        root.classList.remove("light", "dark");

        // Add the current theme class
        root.classList.add(colorMode);
    }, [colorMode]);

    return <>{children}</>;
}
