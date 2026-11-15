import * as React from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

const InputGroup = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
    return (
        <div
            ref={ref}
            className={cn("relative flex items-center w-full", className)}
            {...props}
        />
    );
});
InputGroup.displayName = "InputGroup";

const InputGroupInput = React.forwardRef<
    HTMLInputElement,
    React.ComponentProps<typeof Input>
>(({ className, ...props }, ref) => {
    return (
        <Input
            ref={ref}
            // Add default padding for potential addons.
            // In a robust library this might be dynamic, but for this snippet we assume standard usage.
            className={cn("peer pl-10 pr-16", className)}
            {...props}
        />
    );
});
InputGroupInput.displayName = "InputGroupInput";

const InputGroupAddon = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
        align?: "inline-start" | "inline-end";
    }
>(({ className, align = "inline-start", ...props }, ref) => {
    return (
        <div
            ref={ref}
            className={cn(
                "absolute top-0 bottom-0 flex items-center justify-center pointer-events-none text-muted-foreground",
                align === "inline-start" ? "left-0 pl-3" : "right-0 pr-3",
                className,
            )}
            {...props}
        />
    );
});
InputGroupAddon.displayName = "InputGroupAddon";

export { InputGroup, InputGroupInput, InputGroupAddon };
