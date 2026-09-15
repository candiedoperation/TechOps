/**
 * Horizon's primary navigation, on the People Portal sidebar.
 *
 * The four primary destinations are the four the vanilla shell offered, with
 * the same labels -- "Members" is the recruiting reviewer workspace, which is
 * what that tab has always opened. The source surfaces below it (the Gitea
 * member directory, Profiles, Analytics) were reachable only by URL before and
 * are now addressable from the nav.
 */

import { Link, useLocation } from "react-router-dom"
import {
  DatabaseIcon,
  FolderIcon,
  LayoutGridIcon,
  SparklesIcon,
  TrendingUpIcon,
  UsersIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import logo from "@/assets/adc-256.png"

interface NavItem {
  title: string
  url: string
  icon: LucideIcon
  /** A child route such as /projects/:id keeps its parent highlighted. */
  matchPrefix?: boolean
}

const PRIMARY_NAV: NavItem[] = [
  { title: "Overview", url: "/overview", icon: LayoutGridIcon },
  { title: "Projects", url: "/projects", icon: FolderIcon, matchPrefix: true },
  { title: "Insights", url: "/insights", icon: TrendingUpIcon },
  { title: "Members", url: "/recruiting", icon: SparklesIcon },
]

const SOURCE_NAV: NavItem[] = [
  { title: "Member directory", url: "/members", icon: UsersIcon, matchPrefix: true },
  { title: "Member profiles", url: "/profiles", icon: UsersRoundIcon },
  { title: "Gitea analytics", url: "/analytics", icon: DatabaseIcon },
]

function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.matchPrefix) return pathname === item.url || pathname.startsWith(`${item.url}/`)
  return pathname === item.url
}

function NavSection({ label, items }: { label: string; items: NavItem[] }) {
  const { pathname } = useLocation()

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.url}>
            <SidebarMenuButton tooltip={item.title} isActive={isItemActive(item, pathname)} asChild>
              <Link to={item.url}>
                <item.icon />
                <span>{item.title}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar variant="inset" aria-label="Primary navigation" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/overview" aria-label="Go to Overview">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center overflow-hidden rounded-lg">
                  <img src={logo} alt="App Dev Club" width={32} height={32} />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="font-display truncate font-medium">App Dev Horizon</span>
                  <span className="truncate font-mono text-[10px] tracking-[0.16em]">INTELLIGENCE</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavSection label="Portfolio" items={PRIMARY_NAV} />
        <NavSection label="Sources" items={SOURCE_NAV} />
      </SidebarContent>
    </Sidebar>
  )
}
