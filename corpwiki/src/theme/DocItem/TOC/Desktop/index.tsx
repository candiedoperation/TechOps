import React, { type ReactNode } from "react";
import Desktop from "@theme-original/DocItem/TOC/Desktop";
import type DesktopType from "@theme/DocItem/TOC/Desktop";
import type { WrapperProps } from "@docusaurus/types";

type Props = WrapperProps<typeof DesktopType>;

export default function DesktopWrapper(props: Props): ReactNode {
    return (
        <div className="sticky top-16 py-10 pr-6 pl-8 hidden lg:block max-h-[calc(100vh-4rem)] overflow-y-auto">
            <div className="relative pl-4 border-l border-border">
                <h3 className="font-normal text-sm mb-3 text-muted-foreground">
                    On This Page
                </h3>
                <div className="text-sm">
                    <Desktop {...props} />
                </div>
            </div>
        </div>
    );
}
