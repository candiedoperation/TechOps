import React, { useState, type ReactNode } from "react";
import { useLocation } from "@docusaurus/router";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import { ChevronRight, ChevronDown } from "lucide-react";

// Recursive Sidebar Item
const SidebarItem = ({ item, level = 0 }: { item: any; level?: number }) => {
    const { type, label, href, to, items, collapsed: initialCollapsed } = item;
    const isCategory = type === "category";
    const location = useLocation();

    // Resolve link destination if applicable
    const toUrl = useBaseUrl(to);
    const normalizedHref = useBaseUrl(href, { forcePrependBaseUrl: true });
    const finalLink = href
        ? item.prependBaseUrlToHref
            ? normalizedHref
            : href
        : toUrl;

    // Active state
    const isActive = finalLink && location.pathname === finalLink;

    // Collapsible state for categories
    const [collapsed, setCollapsed] = useState(initialCollapsed ?? false);

    const toggle = (e: React.MouseEvent) => {
        e.preventDefault();
        setCollapsed(!collapsed);
    };

    if (isCategory) {
        return (
            <div className="flex flex-col gap-1 w-full">
                <div
                    onClick={toggle}
                    className={`
                flex items-center justify-between px-3 py-2 rounded-md cursor-pointer transition-colors
                hover:bg-accent hover:text-accent-foreground
                text-sm font-medium
                ${level === 0 ? "font-semibold text-foreground" : "text-muted-foreground"}
            `}
                >
                    <span>{label}</span>
                    {collapsed ? (
                        <ChevronRight size={14} />
                    ) : (
                        <ChevronDown size={14} />
                    )}
                </div>

                {!collapsed && items && (
                    <div className="flex flex-col gap-1 pl-4 border-l border-border/40 ml-4">
                        {items.map((child: any, i: number) => (
                            <SidebarItem
                                key={i}
                                item={child}
                                level={level + 1}
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    }

    if (type === "link") {
        return (
            <Link
                to={finalLink}
                className={`
            flex items-center px-3 py-2 rounded-md text-sm transition-colors w-full
            ${
                isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }
         `}
            >
                {label}
            </Link>
        );
    }

    return null;
};

export default function DocSidebarWrapper(props: any): ReactNode {
    // props.sidebar is the list of items
    const { sidebar } = props;

    return (
        <aside className="mt-[64px] w-full h-full border-r bg-sidebar py-6 pr-4 pl-2 overflow-y-auto">
            <nav className="flex flex-col gap-1">
                {sidebar &&
                    sidebar.map((item: any, i: number) => (
                        <SidebarItem key={i} item={item} level={0} />
                    ))}
            </nav>
        </aside>
    );
}
