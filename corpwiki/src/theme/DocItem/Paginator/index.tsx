import React, { type ReactNode } from "react";
import { useDoc } from "@docusaurus/plugin-content-docs/client";
import Translate from "@docusaurus/Translate";
import Link from "@docusaurus/Link";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

export default function DocItemPaginatorWrapper(): ReactNode {
    const { metadata } = useDoc();
    const { previous, next } = metadata;

    return (
        <nav className="flex items-center justify-between gap-4 mt-4">
            {previous ? (
                <Button
                    variant="ghost"
                    size="sm"
                    asChild
                    className="py-6 flex-1 justify-start"
                >
                    <Link
                        to={previous.permalink}
                        className="flex items-center gap-2"
                    >
                        <ChevronLeft className="h-4 w-4" />
                        <div className="flex flex-col items-start">
                            <span className="text-xs text-muted-foreground">
                                <Translate
                                    id="theme.docs.paginator.previous"
                                    description="The label used to navigate to the previous doc"
                                >
                                    Previous
                                </Translate>
                            </span>
                            <span className="font-medium">
                                {previous.title}
                            </span>
                        </div>
                    </Link>
                </Button>
            ) : (
                <div className="flex-1" />
            )}

            {next ? (
                <Button
                    variant="ghost"
                    size="sm"
                    asChild
                    className="py-6 flex-1 justify-end"
                >
                    <Link
                        to={next.permalink}
                        className="flex items-center gap-2"
                    >
                        <div className="flex flex-col items-end">
                            <span className="text-xs text-muted-foreground">
                                <Translate
                                    id="theme.docs.paginator.next"
                                    description="The label used to navigate to the next doc"
                                >
                                    Next
                                </Translate>
                            </span>
                            <span className="font-medium">{next.title}</span>
                        </div>
                        <ChevronRight className="h-4 w-4" />
                    </Link>
                </Button>
            ) : (
                <div className="flex-1" />
            )}
        </nav>
    );
}
