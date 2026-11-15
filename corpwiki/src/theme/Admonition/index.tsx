import React, { type ReactNode } from "react";
import type AdmonitionType from "@theme/Admonition";
import type { WrapperProps } from "@docusaurus/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
    Info,
    AlertTriangle,
    CheckCircle2,
    Flame,
    Lightbulb,
} from "lucide-react";

type Props = WrapperProps<typeof AdmonitionType>;

// Map Docusaurus admonition types to Shadcn Alert styles and Lucide icons
const ADMONITION_CONFIG = {
    note: {
        icon: Info,
        variant: "default",
        className:
            "bg-blue-50/50 dark:bg-blue-950/20 border-blue-500/50 text-blue-600 dark:border-blue-500 [&>svg]:text-blue-600 dark:text-blue-400 dark:[&>svg]:text-blue-400",
    },
    tip: {
        icon: Lightbulb,
        variant: "default",
        className:
            "bg-green-50/50 dark:bg-green-950/20 border-green-500/50 text-green-600 dark:border-green-500 [&>svg]:text-green-600 dark:text-green-400 dark:[&>svg]:text-green-400",
    },
    info: {
        icon: Info,
        variant: "default",
        className:
            "bg-sky-50/50 dark:bg-sky-950/20 border-sky-500/50 text-sky-600 dark:border-sky-500 [&>svg]:text-sky-600 dark:text-sky-400 dark:[&>svg]:text-sky-400",
    },
    warning: {
        icon: AlertTriangle,
        variant: "default",
        className:
            "bg-yellow-50/50 dark:bg-yellow-950/20 border-yellow-500/50 text-yellow-600 dark:border-yellow-500 [&>svg]:text-yellow-600 dark:text-yellow-400 dark:[&>svg]:text-yellow-400",
    },
    danger: {
        icon: Flame,
        variant: "destructive",
        className:
            "bg-red-50/50 dark:bg-red-950/20 border-red-500/50 text-red-600 dark:border-red-500 [&>svg]:text-red-600 dark:text-red-400 dark:[&>svg]:text-red-400",
    },
} as const;

export default function AdmonitionWrapper(props: Props): ReactNode {
    const { type, title, children } = props;

    // Default to note if type not found
    const config =
        ADMONITION_CONFIG[type as keyof typeof ADMONITION_CONFIG] ||
        ADMONITION_CONFIG.note;
    const Icon = config.icon;

    return (
        <Alert
            variant={config.variant as "default" | "destructive"}
            className={`my-4 ${config.className}`}
        >
            <Icon className="h-4 w-4" />
            <AlertTitle className="font-semibold tracking-tight mb-0">
                {title || type.charAt(0).toUpperCase() + type.slice(1)}
            </AlertTitle>
            <AlertDescription className="text-sm mt-1 [&_p]:!my-0 [&_p]:!leading-normal">
                {children}
            </AlertDescription>
        </Alert>
    );
}
