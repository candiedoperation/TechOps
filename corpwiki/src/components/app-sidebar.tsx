"use client";

import * as React from "react";
import { Command } from "lucide-react";

import { NavMain } from "@/components/nav-main";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar";

import appconfig from "@/appconfig";

export function AppSidebar({
    items,
    ...props
}: React.ComponentProps<typeof Sidebar> & { items: any[] }) {
    return (
        <Sidebar variant="inset" {...props}>
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton size="lg" asChild>
                            <a href="/">
                                <div className="text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                                    <img src={appconfig.logo} alt="Logo" />
                                </div>
                                <div className="grid flex-1 text-left text-sm leading-tight font-semibold">
                                    <span className="truncate">
                                        {appconfig.title}
                                    </span>
                                    <span className="truncate text-xs">
                                        {appconfig.description}
                                    </span>
                                </div>
                            </a>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
                <NavMain items={items} />
            </SidebarContent>
            <SidebarFooter>{/* Footer content if needed */}</SidebarFooter>
        </Sidebar>
    );
}
