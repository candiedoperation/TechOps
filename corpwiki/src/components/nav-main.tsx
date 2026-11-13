import { useLocation } from "@docusaurus/router";
import { useEffect, useState } from "react";
import { ChevronRight, FileText, Folder } from "lucide-react"
import Link from '@docusaurus/Link';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@/components/ui/sidebar"

// Helper to recursively check if an item or its children are active
const checkIsActive = (item: any, pathname: string): boolean => {
  /* Strip a trailing slash, but never reduce "/" to "". The site root is a real
     route (docs/intro.md carries slug: /), and collapsing it to the empty string
     made it equal the empty href of every category that has no `link` in its
     _category_.json. On "/" alone, those categories all reported active and the
     sidebar opened them, along with their parents. */
  const normalize = (str: string) =>
    str.length > 1 ? str.replace(/\/$/, "") : str;
  const normalizedHref = normalize(item.href || "");
  const normalizedPath = normalize(pathname);

  /* A link-less category has no href; it is never the active page itself, only
     possibly the parent of one. */
  if (normalizedHref && normalizedHref === normalizedPath) return true;
  if (item.items && item.items.length > 0) {
    return item.items.some((child: any) => checkIsActive(child, pathname));
  }
  return false;
};

// Simple recursive component for rendering sidebar items
function SidebarItemRenderer({ item }: { item: any }) {
  const location = useLocation();
  const pathname = location.pathname;

  // State for collapsible
  // We initialize based on whether we are currently active, 
  // but we also listen to changes in pathname to auto-expand.
  const [isOpen, setIsOpen] = useState(() => checkIsActive(item, pathname));

  useEffect(() => {
    if (checkIsActive(item, pathname)) {
      setIsOpen(true);
    }
  }, [pathname, item]);

  // If it has "items" array, treat as category
  if (item.items && item.items.length > 0) {
    const isActiveCategory = checkIsActive(item, pathname);

    return (
      <Collapsible
        key={item.label}
        asChild
        open={isOpen}
        onOpenChange={setIsOpen}
        className="group/collapsible"
      >
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              tooltip={item.label}
              className="h-auto py-2 px-2 whitespace-normal [&>span]:whitespace-normal [&>span]:text-wrap text-left items-start"
            >
              <Folder className="mr-2 size-4 shrink-0 mt-0.5" />
              <span className="flex-1 leading-tight">{item.label}</span>
              <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 shrink-0 mt-0.5" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub>
              {item.items.map((subItem: any, index: number) => (
                <SidebarItemRenderer key={index} item={subItem} />
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    )
  }

  // Otherwise treat as link
  const isActiveLink = item.href === pathname;

  return (
    <SidebarMenuItem key={item.label}>
      <SidebarMenuButton
        asChild
        isActive={isActiveLink}
        tooltip={item.label}
        className="h-auto py-2 px-2 whitespace-normal [&>span]:whitespace-normal [&>span]:text-wrap text-left items-start"
      >
        <Link to={item.href} className="flex w-full items-start">
          <FileText className="mr-2 size-4 shrink-0 mt-0.5" />
          <span className="flex-1 leading-tight">{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function NavMain({ items }: { items: any[] }) {
  if (!items || !items.length) return null

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Wiki</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item, index) => (
          <SidebarItemRenderer key={index} item={item} />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}

