/**
 * The app shell: People Portal's sidebar layout, Horizon's routes.
 */

import { Navigate, Route, Routes, useLocation } from "react-router-dom"

import { AppSidebar } from "@/components/app-sidebar"
import { OperatorSessionDialog } from "@/components/horizon/operator-session-dialog"
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Analytics } from "@/pages/Analytics"
import { Insights } from "@/pages/Insights"
import { MemberDetail } from "@/pages/MemberDetail"
import { MemberDirectory } from "@/pages/MemberDirectory"
import { Overview } from "@/pages/Overview"
import { ProgressDetail } from "@/pages/ProgressDetail"
import { ProjectProfile } from "@/pages/ProjectProfile"
import { Projects } from "@/pages/Projects"
import { Profiles } from "@/pages/Profiles"
import { Recruiting } from "@/pages/Recruiting"

const SECTION_TITLES: Record<string, string> = {
  overview: "Overview",
  projects: "Projects",
  insights: "Insights",
  recruiting: "Members",
  members: "Member directory",
  profiles: "Member profiles",
  analytics: "Gitea analytics",
}

function CurrentSection() {
  const { pathname } = useLocation()
  const segment = pathname.split("/").filter(Boolean)[0] ?? "overview"
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbPage>{SECTION_TITLES[segment] ?? "App Dev Horizon"}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function App() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 px-6">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <CurrentSection />
          <div className="ml-auto">
            <OperatorSessionDialog />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6 pt-0">
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId" element={<ProjectProfile />} />
            <Route path="/projects/:projectId/progress" element={<ProgressDetail />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/recruiting" element={<Recruiting />} />
            <Route path="/members" element={<MemberDirectory />} />
            <Route path="/members/:login" element={<MemberDetail />} />
            <Route path="/profiles" element={<Profiles />} />
            <Route path="/analytics" element={<Analytics />} />
            {/* Unknown routes fall back to Overview and replace the bad history
                entry, so Back does not walk straight into it again. */}
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
