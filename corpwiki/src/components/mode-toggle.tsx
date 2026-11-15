import React from "react";
import { useColorMode } from "@docusaurus/theme-common";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";

export function ModeToggle() {
    const { colorMode, setColorMode } = useColorMode();

    const toggleColorMode = () => {
        setColorMode(colorMode === "dark" ? "light" : "dark");
    };

    return (
        <Button
            variant="outline"
            size="icon"
            onClick={toggleColorMode}
            aria-label="Toggle theme"
        >
            {colorMode === "dark" ? (
                <Sun className="h-4 w-4" />
            ) : (
                <Moon className="h-4 w-4" />
            )}
        </Button>
    );
}
