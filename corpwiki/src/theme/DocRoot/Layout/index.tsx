import React, { Fragment } from "react";
import {
  useDocsSidebar,
  useSidebarBreadcrumbs,
} from "@docusaurus/plugin-content-docs/client";
import Link from "@docusaurus/Link";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import SearchBarWrapper from "@/theme/SearchBar";
import { ModeToggle } from "@/components/mode-toggle";
import appconfig from "@/appconfig";

export default function DocRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sidebar = useDocsSidebar();
  const breadcrumbs = useSidebarBreadcrumbs();

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar items={sidebar?.items || []} />
      <SidebarInset className="overflow-hidden">
        <header className="flex h-16 shrink-0 items-center gap-2">
          <div className="flex items-center gap-2 px-6 w-full">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-[orientation=vertical]:h-6"
            />
            <Breadcrumb className="flex-grow-1">
              <BreadcrumbList>
                {breadcrumbs?.map((item, idx) => {
                  const isLast = idx === breadcrumbs.length - 1;
                  return (
                    <Fragment key={idx}>
                      <BreadcrumbItem className="hidden md:block">
                        {isLast ? (
                          <BreadcrumbPage>{item.label}</BreadcrumbPage>
                        ) : (
                          <Link
                            to={item.href}
                            className="hover:underline transition-colors hover:text-foreground"
                          >
                            {item.label}
                          </Link>
                        )}
                      </BreadcrumbItem>
                      {!isLast && (
                        <BreadcrumbSeparator className="hidden md:block" />
                      )}
                    </Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>

            {/* Dark Mode Toggle & Search Bar */}
            <SearchBarWrapper />
            <ModeToggle />
          </div>
        </header>
        <div
          id="docusaurus-base-url-issue-banner"
          className="flex flex-1 flex-col gap-4 p-6 pt-0 mt-2 overflow-y-auto"
          onScroll={(e) => {
            // Dispatch a scroll event to document so useTOCHighlight can detect it
            const scrollEvent = new Event("scroll", { bubbles: true });
            document.dispatchEvent(scrollEvent);
          }}
        >
          {children}
          <p className="mt-auto text-xs text-muted-foreground">
            {appconfig.copyrightText}
          </p>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
