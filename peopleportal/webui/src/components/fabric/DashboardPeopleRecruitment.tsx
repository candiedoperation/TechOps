/**
  People Portal UI
  Copyright (C) 2026  Atheesh Thirumalairajan

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import React from "react";
import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import {
    flexRender,
    getCoreRowModel,
    getPaginationRowModel,
    useReactTable,
    type ColumnDef,
    type PaginationState,
} from "@tanstack/react-table";
import {
    ClipboardCheckIcon,
    CopyCheckIcon,
    ExternalLinkIcon,
    HeadsetIcon,
    Loader2Icon,
    MoreVerticalIcon,
    PartyPopperIcon,
    ThumbsDownIcon,
    XIcon,
} from "lucide-react";
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from "../ui/accordion";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
    Card,
    CardAction,
    CardContent,
    CardHeader,
    CardTitle,
} from "../ui/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from "../ui/pagination";
import Ratings from "../ui/ratings";
import { ScrollArea } from "../ui/scroll-area";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../ui/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "../ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import { Timeline, TimelineItem } from "../ui/timeline";

/* Open Team (From /api/ats/openteams) */
interface OpenTeam {
    teamPk: string;
    teamInfo: {
        friendlyName: string;
        seasonText: string;
        pk: string;
    };
    subteamInfo: {
        [subteamPk: string]: {
            friendlyName: string;
            description?: string;
        };
    };
}

/* Response of GET /api/ats/applications/allApplications */
interface AllApplicationsEntry {
    applicantId: string;
    applicantName: string;
    applicantEmail: string;
    applications: {
        id: string;
        teamPk: string;
        teamName: string;
        rolePreferences: {
            role: string;
            subteamPk: string;
            subteamName?: string;
        }[];
        stage: string;
        appliedAt: string;
        hiredRole?: string;
    }[];
}

/* Response of GET /api/ats/applicantApplications/:applicantId */
type ApplicantApplicationsEntry = AllApplicationsEntry["applications"][number];

/* One application, flattened out of an AllApplicationsEntry */
interface RecruitmentApplication {
    id: string;
    name: string;
    email: string;
    stage: string;
    applicantId: string;
    rolePreferences: {
        role: string;
        subteamPk: string;
        subteamName?: string;
    }[];
    appliedAt: string;
    stars: number;
    teamPk: string;
    teamName: string;
    hiredRole?: string;
    [key: string]: unknown; // Index signature for Kanban compatibility
}

/* Full Application Details (From /api/ats/applications/:teamId/:id/info) */
interface RecruitmentApplicationDetails extends RecruitmentApplication {
    profile: { [key: string]: string };
    responses: { [key: string]: string };
    notes?: string;
    stageHistory?: {
        stage: string;
        changedAt: string;
        changedBy?: string;
    }[];
}

interface StageDefinition {
    id: string;
    name: string;
    [key: string]: unknown; // Index signature for Kanban compatibility
}

/* One row per applicant, containing every application we could see */
interface ApplicantRow {
    applicantId: string;
    name: string;
    apps: RecruitmentApplication[];
}

const PAGE_SIZE = 12;
const MIN_PANEL_WIDTH = 340;
const MAX_PANEL_WIDTH = 720;
const ALL_FILTER = "all";

const STAGE_STYLES: { [key: string]: string } = {
    Applied:
        "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-400 dark:bg-blue-500/10 dark:border-blue-500/30",
    Interview:
        "text-purple-700 bg-purple-50 border-purple-200 dark:text-purple-400 dark:bg-purple-500/10 dark:border-purple-500/30",
    Hired: "text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-500/10 dark:border-green-500/30",
    Rejected:
        "text-red-700 bg-red-50 border-red-200 dark:text-red-400 dark:bg-red-500/10 dark:border-red-500/30",
    "Potential Hire":
        "text-orange-700 bg-orange-50 border-orange-200 dark:text-orange-400 dark:bg-orange-500/10 dark:border-orange-500/30",
};

const SECTION_CARD =
    "gap-3 shadow-none bg-muted/30 [&>*:first-child]:pt-4 [&>*:last-child]:pb-4";

const getInitials = (name: string) =>
    name
        .split(" ")
        .map((part) => part[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();

/** Job title from the application (`rolePreferences.role`), not the subteam name. */
const formatRolePreferenceLabel = (pref: {
    role: string;
    subteamPk: string;
    subteamName?: string;
}) => pref.role?.trim() || "Role title missing";

const formatShortDate = (date: string) =>
    new Date(date).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
    });

const formatLongDate = (date: string) =>
    new Date(date).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    });

/* Windowed page list so large result sets don't render every page button */
const getPageNumbers = (current: number, total: number) => {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i);

    const pages = [0, total - 1, current - 1, current, current + 1]
        .filter((p) => p >= 0 && p < total)
        .filter((p, i, arr) => arr.indexOf(p) === i)
        .sort((a, b) => a - b);

    const result: (number | "ellipsis")[] = [];
    pages.forEach((page, i) => {
        if (i > 0 && page - pages[i - 1] > 1) result.push("ellipsis");
        result.push(page);
    });
    return result;
};

export const DashboardPeopleRecruitment = () => {
    const navigate = useNavigate();

    /* Data */
    const [openTeams, setOpenTeams] = React.useState<OpenTeam[]>([]);
    const [stages, setStages] = React.useState<StageDefinition[]>([]);
    const [applications, setApplications] = React.useState<
        RecruitmentApplication[]
    >([]);
    const [isLoading, setIsLoading] = React.useState(true);
    const [reviewerName, setReviewerName] = React.useState("");

    /* Per-application details & resumes are loaded lazily and cached */
    const [detailsCache, setDetailsCache] = React.useState<{
        [applicationId: string]: RecruitmentApplicationDetails;
    }>({});
    const [detailsFailed, setDetailsFailed] = React.useState<{
        [applicationId: string]: boolean;
    }>({});
    const [resumeUrls, setResumeUrls] = React.useState<{
        [applicationId: string]: string;
    }>({});
    const requestedDetails = React.useRef<Set<string>>(new Set());
    const requestedResumes = React.useRef<Set<string>>(new Set());
    const requestedApplicantApps = React.useRef<Set<string>>(new Set());

    /* Filters */
    const [search, setSearch] = React.useState("");
    const [orgFilter, setOrgFilter] = React.useState(ALL_FILTER);
    const [statusFilter, setStatusFilter] = React.useState(ALL_FILTER);
    const [pagination, setPagination] = React.useState<PaginationState>({
        pageIndex: 0,
        pageSize: PAGE_SIZE,
    });

    /* Applicant Detail Panel */
    const [selectedApplicantId, setSelectedApplicantId] = React.useState<
        string | null
    >(null);
    const [activeAppId, setActiveAppId] = React.useState<string | null>(null);
    const [activeRoles, setActiveRoles] = React.useState<{
        [applicationId: string]: string;
    }>({});
    const [detailTab, setDetailTab] = React.useState("overview");
    const [panelWidth, setPanelWidth] = React.useState(410);
    const [isResizing, setIsResizing] = React.useState(false);
    const layoutRef = React.useRef<HTMLDivElement>(null);

    /* Private Notes */
    const [notesText, setNotesText] = React.useState("");
    const [savedNotesText, setSavedNotesText] = React.useState("");

    /* --- Data Fetching --- */
    React.useEffect(() => {
        fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/auth/userinfo`)
            .then(async (response) => {
                const userInfo = await response.json();
                if (response.ok) setReviewerName(userInfo.name);
            })
            .catch(console.error);
    }, []);

    React.useEffect(() => {
        fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/stages`)
            .then(async (response) => {
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(
                        errorData.message || "Failed to fetch stages",
                    );
                }
                setStages(await response.json());
            })
            .catch((e) => {
                toast.error("Failed to load application stages: " + e.message);
            });
    }, []);

    /* Recruiting teams, used for the organization filter and role descriptions */
    React.useEffect(() => {
        fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/openteams`)
            .then(async (response) => {
                const teams = await response.json();
                if (!response.ok)
                    throw new Error(teams.message || "Failed to fetch teams");
                setOpenTeams(teams);
            })
            .catch((e) => {
                toast.error("Failed to Fetch Recruiting Teams: " + e.message);
            });
    }, []);

    function mapApplicationForApplicant(
        entry: Pick<
            AllApplicationsEntry,
            "applicantId" | "applicantName" | "applicantEmail"
        >,
        app: ApplicantApplicationsEntry,
        stars = 0,
    ): RecruitmentApplication {
        return {
            id: app.id,
            applicantId: entry.applicantId,
            name: entry.applicantName,
            email: entry.applicantEmail,
            stage: app.stage,
            appliedAt: app.appliedAt,
            rolePreferences: (app.rolePreferences ?? []).map((p) => ({
                role: p.role,
                subteamPk: p.subteamPk,
                subteamName: p.subteamName,
            })),
            teamPk: app.teamPk,
            teamName: app.teamName,
            hiredRole: app.hiredRole,
            stars,
        };
    }

    function mergeApplicantApplications(
        applicantId: string,
        name: string,
        email: string,
        apps: ApplicantApplicationsEntry[],
    ) {
        setApplications((prev) => {
            const starsById = new Map(
                prev
                    .filter((a) => a.applicantId === applicantId)
                    .map((a) => [a.id, a.stars ?? 0]),
            );
            const rest = prev.filter((a) => a.applicantId !== applicantId);
            const merged = apps.map((app) =>
                mapApplicationForApplicant(
                    { applicantId, applicantName: name, applicantEmail: email },
                    app,
                    starsById.get(app.id) ?? 0,
                ),
            );
            return [...rest, ...merged];
        });
    }

    /* One application per applicant for the table; full list loads on View */
    React.useEffect(() => {
        fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/allApplications`)
            .then(async (response) => {
                const data = await response.json();
                if (!response.ok)
                    throw new Error(
                        data.message || "Failed to fetch applications",
                    );

                setApplications(
                    (data as AllApplicationsEntry[]).flatMap((entry) =>
                        entry.applications.map((app) =>
                            mapApplicationForApplicant(entry, app),
                        ),
                    ),
                );
            })
            .catch((e) => {
                console.log("Failed to Fetch Applications: " + e.message);
            })
            .finally(() => setIsLoading(false));
    }, []);

    function loadApplicantApplications(row: ApplicantRow) {
        if (requestedApplicantApps.current.has(row.applicantId)) return;
        requestedApplicantApps.current.add(row.applicantId);

        fetch(
            `${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/applicantApplications/${row.applicantId}`,
        )
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok)
                    throw new Error(
                        data.message || "Failed to fetch applications",
                    );
                mergeApplicantApplications(
                    row.applicantId,
                    row.name,
                    getEmail(row),
                    data as ApplicantApplicationsEntry[],
                );
            })
            .catch((err) => {
                requestedApplicantApps.current.delete(row.applicantId);
                toast.error(
                    "Failed to load applicant applications: " + err.message,
                );
            });
    }

    function loadDetails(app: RecruitmentApplication, notify = false) {
        if (requestedDetails.current.has(app.id)) return;
        requestedDetails.current.add(app.id);

        fetch(
            `${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/applications/${app.teamPk}/${app.id}/info`,
        )
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok)
                    throw new Error(data.message || "Failed to fetch details");
                setDetailsCache((prev) => ({
                    ...prev,
                    [app.id]: { ...data, teamPk: app.teamPk },
                }));
            })
            .catch((err) => {
                setDetailsFailed((prev) => ({ ...prev, [app.id]: true }));
                if (notify)
                    toast.error(
                        "Failed to load application details: " + err.message,
                    );
            });
    }

    function loadResume(app: RecruitmentApplication) {
        if (requestedResumes.current.has(app.id)) return;
        requestedResumes.current.add(app.id);

        fetch(
            `${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/applications/${app.teamPk}/${app.applicantId}/resume`,
        )
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok)
                    throw new Error(data.message || "Failed to fetch resume");
                setResumeUrls((prev) => ({
                    ...prev,
                    [app.id]: data.resumeUrl,
                }));
            })
            .catch((err) => {
                toast.error("Failed to load resume: " + err.message);
            });
    }

    /* --- Derived Data --- */
    const applicants = React.useMemo<ApplicantRow[]>(() => {
        const byApplicant = new Map<string, ApplicantRow>();
        applications.forEach((app) => {
            const existing = byApplicant.get(app.applicantId);
            if (existing) existing.apps.push(app);
            else
                byApplicant.set(app.applicantId, {
                    applicantId: app.applicantId,
                    name: app.name,
                    apps: [app],
                });
        });

        const rows = Array.from(byApplicant.values());
        rows.forEach((row) =>
            row.apps.sort(
                (a, b) =>
                    new Date(b.appliedAt).getTime() -
                    new Date(a.appliedAt).getTime(),
            ),
        );
        return rows.sort(
            (a, b) =>
                new Date(b.apps[0].appliedAt).getTime() -
                new Date(a.apps[0].appliedAt).getTime(),
        );
    }, [applications]);

    /* The application a row represents: the selected org's, else the latest */
    const getViewApp = (row: ApplicantRow) =>
        (orgFilter !== ALL_FILTER
            ? row.apps.find((app) => app.teamPk === orgFilter)
            : undefined) ?? row.apps[0];

    const getEmail = (row: ApplicantRow) =>
        row.apps.map((app) => app.email).find(Boolean) ?? "";

    const filteredApplicants = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        return applicants.filter((row) => {
            const viewApp = getViewApp(row);
            const textMatch =
                !q ||
                row.name.toLowerCase().includes(q) ||
                getEmail(row).toLowerCase().includes(q);
            const orgMatch =
                orgFilter === ALL_FILTER ||
                row.apps.some((app) => app.teamPk === orgFilter);
            const statusMatch =
                statusFilter === ALL_FILTER || viewApp.stage === statusFilter;
            return textMatch && orgMatch && statusMatch;
        });
    }, [applicants, search, orgFilter, statusFilter]);

    const seasons = Array.from(
        new Set(openTeams.map((team) => team.teamInfo.seasonText)),
    );

    const selectedApplicant =
        applicants.find((row) => row.applicantId === selectedApplicantId) ??
        null;
    const activeApp =
        selectedApplicant?.apps.find((app) => app.id === activeAppId) ??
        selectedApplicant?.apps[0] ??
        null;
    const activeDetails = activeApp ? detailsCache[activeApp.id] : undefined;
    const activeEmail = selectedApplicant ? getEmail(selectedApplicant) : "";

    /* Reset to the first page whenever the result set changes */
    React.useEffect(() => {
        setPagination((prev) => ({ ...prev, pageIndex: 0 }));
    }, [search, orgFilter, statusFilter]);

    /* Load everything the open panel needs */
    React.useEffect(() => {
        if (!activeApp) return;
        loadDetails(activeApp, true);
        loadResume(activeApp);
    }, [activeApp?.id]);

    React.useEffect(() => {
        if (!selectedApplicantId) return;
        const stored =
            localStorage.getItem(`recruitmentNotes:${selectedApplicantId}`) ??
            "";
        setNotesText(stored);
        setSavedNotesText(stored);
    }, [selectedApplicantId]);

    const renderStageBadge = (stage: string) => (
        <Badge variant="outline" className={cn(STAGE_STYLES[stage])}>
            {stage}
        </Badge>
    );

    /* --- Table --- */
    const columns: ColumnDef<ApplicantRow>[] = [
        {
            id: "name",
            header: "Name",
            cell: ({ row }) => (
                <span className="font-medium text-sm">{row.original.name}</span>
            ),
        },
        {
            id: "email",
            header: "Email",
            cell: ({ row }) => {
                const email = getEmail(row.original);
                return (
                    <span className="text-sm text-muted-foreground">
                        {email || "—"}
                    </span>
                );
            },
        },
        {
            id: "appliedTo",
            header: "Applied To",
            cell: ({ row }) => {
                const app = getViewApp(row.original);
                return (
                    <div className="flex flex-col">
                        <span className="text-sm">{app.teamName}</span>
                        <span className="text-xs text-muted-foreground">
                            {app.rolePreferences
                                .map((pref) => pref.role)
                                .join(", ")}
                        </span>
                    </div>
                );
            },
        },
        {
            id: "status",
            header: "Status",
            cell: ({ row }) => renderStageBadge(getViewApp(row.original).stage),
        },
        {
            id: "applied",
            header: "Applied",
            cell: ({ row }) => (
                <span className="text-sm text-muted-foreground">
                    {formatShortDate(getViewApp(row.original).appliedAt)}
                </span>
            ),
        },
        {
            id: "rating",
            header: "Rating",
            cell: ({ row }) => (
                <Ratings
                    variant="yellow"
                    totalStars={5}
                    value={getViewApp(row.original).stars ?? 0}
                    size={14}
                />
            ),
        },
        {
            id: "otherApps",
            header: "Other Apps",
            cell: ({ row }) => (
                <span className="text-sm text-muted-foreground">
                    {Math.max(0, row.original.apps.length - 1)}
                </span>
            ),
        },
        {
            id: "review",
            header: () => <div className="text-right">Review</div>,
            cell: ({ row }) => (
                <div className="text-right">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openApplicant(row.original)}
                    >
                        View
                    </Button>
                </div>
            ),
        },
    ];

    const table = useReactTable({
        columns,
        data: filteredApplicants,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        autoResetPageIndex: false,
        onPaginationChange: setPagination,
        state: { pagination },
    });

    const pageRows = table.getRowModel().rows;
    const pageCount = table.getPageCount();
    const pageStart = pagination.pageIndex * PAGE_SIZE;

    /* --- Actions --- */
    function openApplicant(row: ApplicantRow, app?: RecruitmentApplication) {
        loadApplicantApplications(row);
        setSelectedApplicantId(row.applicantId);
        setActiveAppId((app ?? getViewApp(row)).id);
        setDetailTab("overview");
    }

    function closeApplicant() {
        setSelectedApplicantId(null);
        setActiveAppId(null);
    }

    /*
     * TODO(endpoint): Private reviewer notes.
     * PUT /api/ats/applications/:teamId/:applicationId/feedback stores notes
     * shared with the whole team, so it can't back "My Private Notes". Until
     * a per-reviewer notes endpoint exists, notes only live in localStorage
     * on this device.
     */
    function saveNotes() {
        if (!selectedApplicantId) return;
        localStorage.setItem(
            `recruitmentNotes:${selectedApplicantId}`,
            notesText,
        );
        setSavedNotesText(notesText);
    }

    const clampPanelWidth = (width: number) => {
        const layoutWidth =
            layoutRef.current?.getBoundingClientRect().width ?? 0;
        const max = Math.min(
            MAX_PANEL_WIDTH,
            Math.max(MIN_PANEL_WIDTH, layoutWidth - 420),
        );
        return Math.max(MIN_PANEL_WIDTH, Math.min(max, width));
    };

    function handleResizeMove(e: React.PointerEvent) {
        if (!isResizing || !layoutRef.current) return;
        const rect = layoutRef.current.getBoundingClientRect();
        setPanelWidth(clampPanelWidth(rect.right - e.clientX));
    }

    function handleResizeKey(e: React.KeyboardEvent) {
        if (e.key === "ArrowLeft")
            setPanelWidth(clampPanelWidth(panelWidth + 24));
        else if (e.key === "ArrowRight")
            setPanelWidth(clampPanelWidth(panelWidth - 24));
        else if (e.key === "Home")
            setPanelWidth(clampPanelWidth(MIN_PANEL_WIDTH));
        else if (e.key === "End")
            setPanelWidth(clampPanelWidth(MAX_PANEL_WIDTH));
        else return;
        e.preventDefault();
    }

    /* --- MISC UI STUFF --- */
    const getTimelineStageIcon = (stage: string) => {
        switch (stage) {
            case "Applied":
                return <ClipboardCheckIcon />;
            case "Interview":
                return <HeadsetIcon />;
            case "Potential Hire":
                return <CopyCheckIcon />;
            case "Hired":
                return <PartyPopperIcon />;
            case "Rejected":
                return <ThumbsDownIcon />;
        }
    };

    const notesState =
        notesText !== savedNotesText
            ? "Unsaved changes"
            : savedNotesText
              ? "Saved locally on this device"
              : "Not saved";

    return (
        <div className="flex flex-col m-2 h-full">
            <div className="flex items-start">
                <div className="flex flex-col flex-grow-1">
                    <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight text-balance">
                        Recruitment Tracker
                    </h1>
                    <h4 className="text-xl text-muted-foreground">
                        {seasons.length === 1
                            ? seasons[0]
                            : "All Recruiting Teams"}
                    </h4>
                </div>
                {reviewerName && (
                    <div className="text-right">
                        <div className="text-xs text-muted-foreground mb-1">
                            Reviewer
                        </div>
                        <div className="font-semibold">{reviewerName}</div>
                    </div>
                )}
            </div>

            <div className="mt-5 flex flex-col flex-grow min-h-0">
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <Select value={orgFilter} onValueChange={setOrgFilter}>
                        <SelectTrigger className="w-[200px]">
                            <SelectValue placeholder="All organizations" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ALL_FILTER}>
                                All organizations
                            </SelectItem>
                            {openTeams.map((team) => (
                                <SelectItem
                                    key={team.teamPk}
                                    value={team.teamPk}
                                >
                                    {team.teamInfo.friendlyName}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select
                        value={statusFilter}
                        onValueChange={setStatusFilter}
                    >
                        <SelectTrigger className="w-[180px]">
                            <SelectValue placeholder="All statuses" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ALL_FILTER}>
                                All statuses
                            </SelectItem>
                            {stages.map((stage) => (
                                <SelectItem key={stage.id} value={stage.id}>
                                    {stage.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Input
                        placeholder="Search by name or email..."
                        value={search}
                        className="w-72"
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>

                <div className="mt-4 flex flex-col flex-grow min-h-0">
                    <div
                        ref={layoutRef}
                        className="flex gap-0 items-start w-full min-h-0 flex-1"
                    >
                        <div className="min-w-0 flex-1 pr-2">
                                <div className="overflow-x-auto rounded-md border">
                                    <Table>
                                        <TableHeader>
                                            {table
                                                .getHeaderGroups()
                                                .map((headerGroup) => (
                                                    <TableRow
                                                        key={headerGroup.id}
                                                    >
                                                        {headerGroup.headers.map(
                                                            (header) => (
                                                                <TableHead
                                                                    key={
                                                                        header.id
                                                                    }
                                                                >
                                                                    {header.isPlaceholder
                                                                        ? null
                                                                        : flexRender(
                                                                              header
                                                                                  .column
                                                                                  .columnDef
                                                                                  .header,
                                                                              header.getContext(),
                                                                          )}
                                                                </TableHead>
                                                            ),
                                                        )}
                                                    </TableRow>
                                                ))}
                                        </TableHeader>
                                        <TableBody>
                                            {pageRows.length ? (
                                                pageRows.map((row) => (
                                                    <TableRow
                                                        key={row.id}
                                                        data-state={
                                                            row.original
                                                                .applicantId ===
                                                                selectedApplicantId &&
                                                            "selected"
                                                        }
                                                    >
                                                        {row
                                                            .getVisibleCells()
                                                            .map((cell) => (
                                                                <TableCell
                                                                    key={
                                                                        cell.id
                                                                    }
                                                                >
                                                                    {flexRender(
                                                                        cell
                                                                            .column
                                                                            .columnDef
                                                                            .cell,
                                                                        cell.getContext(),
                                                                    )}
                                                                </TableCell>
                                                            ))}
                                                    </TableRow>
                                                ))
                                            ) : (
                                                <TableRow>
                                                    <TableCell
                                                        colSpan={columns.length}
                                                        className="h-24 text-center text-muted-foreground"
                                                    >
                                                        {isLoading ? (
                                                            <Loader2Icon className="animate-spin h-6 w-6 mx-auto" />
                                                        ) : (
                                                            "No applicants match these filters."
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            )}
                                        </TableBody>
                                    </Table>
                                </div>

                                <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
                                    <div className="whitespace-nowrap">
                                        {filteredApplicants.length > 0 &&
                                            `Showing ${pageStart + 1}–${Math.min(
                                                pageStart + PAGE_SIZE,
                                                filteredApplicants.length,
                                            )} of ${filteredApplicants.length}`}
                                    </div>
                                    <Pagination className="mx-0 w-auto">
                                        <PaginationContent>
                                            <PaginationItem>
                                                <PaginationPrevious
                                                    className={cn(
                                                        "cursor-pointer",
                                                        !table.getCanPreviousPage() &&
                                                            "pointer-events-none opacity-40",
                                                    )}
                                                    onClick={() =>
                                                        table.previousPage()
                                                    }
                                                />
                                            </PaginationItem>
                                            {getPageNumbers(
                                                pagination.pageIndex,
                                                pageCount,
                                            ).map((page, i) => (
                                                <PaginationItem
                                                    key={`${page}-${i}`}
                                                >
                                                    {page === "ellipsis" ? (
                                                        <PaginationEllipsis />
                                                    ) : (
                                                        <PaginationLink
                                                            className="cursor-pointer"
                                                            isActive={
                                                                page ===
                                                                pagination.pageIndex
                                                            }
                                                            onClick={() =>
                                                                table.setPageIndex(
                                                                    page,
                                                                )
                                                            }
                                                        >
                                                            {page + 1}
                                                        </PaginationLink>
                                                    )}
                                                </PaginationItem>
                                            ))}
                                            <PaginationItem>
                                                <PaginationNext
                                                    className={cn(
                                                        "cursor-pointer",
                                                        !table.getCanNextPage() &&
                                                            "pointer-events-none opacity-40",
                                                    )}
                                                    onClick={() =>
                                                        table.nextPage()
                                                    }
                                                />
                                            </PaginationItem>
                                        </PaginationContent>
                                    </Pagination>
                                </div>
                            </div>

                            {selectedApplicant && activeApp && (
                                <>
                                    {/* Resize Handle */}
                                    <div
                                        className="w-3 shrink-0 cursor-col-resize group relative self-stretch"
                                        role="separator"
                                        aria-orientation="vertical"
                                        aria-label="Resize applicant detail panel"
                                        tabIndex={0}
                                        onPointerDown={(e) => {
                                            e.currentTarget.setPointerCapture(
                                                e.pointerId,
                                            );
                                            setIsResizing(true);
                                        }}
                                        onPointerMove={handleResizeMove}
                                        onPointerUp={() => setIsResizing(false)}
                                        onPointerCancel={() =>
                                            setIsResizing(false)
                                        }
                                        onKeyDown={handleResizeKey}
                                    >
                                        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-muted-foreground" />
                                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-12 w-1 rounded-full bg-border group-hover:bg-muted-foreground" />
                                    </div>

                                    {/* Applicant Detail Panel */}
                                    <Card
                                        className="gap-0 py-0 shrink-0 self-stretch flex flex-col max-h-[calc(100vh-9rem)] min-h-[28rem] [&>*:first-child]:pt-0 [&>*:last-child]:pb-0"
                                        style={{
                                            width: panelWidth,
                                            minWidth: MIN_PANEL_WIDTH,
                                            maxWidth: MAX_PANEL_WIDTH,
                                        }}
                                    >
                                        <Tabs
                                            value={detailTab}
                                            onValueChange={setDetailTab}
                                            className="flex min-h-0 flex-1 flex-col gap-0"
                                        >
                                            <div className="shrink-0 border-b px-4 pb-4 pt-4">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="flex gap-3 min-w-0">
                                                        <Avatar className="h-10 w-10 shrink-0 border">
                                                            <AvatarFallback className="text-sm font-bold">
                                                                {getInitials(
                                                                    selectedApplicant.name,
                                                                )}
                                                            </AvatarFallback>
                                                        </Avatar>
                                                        <div className="min-w-0">
                                                            <div className="text-lg font-semibold leading-tight truncate">
                                                                {
                                                                    selectedApplicant.name
                                                                }
                                                            </div>
                                                            <div className="text-sm text-muted-foreground mt-1 truncate">
                                                                {activeEmail ||
                                                                    "Loading email..."}
                                                            </div>
                                                            <div className="text-xs text-muted-foreground mt-1">
                                                                Applied{" "}
                                                                {formatLongDate(
                                                                    activeApp.appliedAt,
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {renderStageBadge(
                                                            activeApp.stage,
                                                        )}
                                                        <DropdownMenu>
                                                            <DropdownMenuTrigger
                                                                asChild
                                                            >
                                                                <Button
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className="h-8 w-8"
                                                                >
                                                                    <MoreVerticalIcon />
                                                                </Button>
                                                            </DropdownMenuTrigger>
                                                            <DropdownMenuContent align="end">
                                                                <DropdownMenuItem
                                                                    disabled={
                                                                        !activeEmail
                                                                    }
                                                                    onClick={async () => {
                                                                        try {
                                                                            await navigator.clipboard.writeText(
                                                                                activeEmail,
                                                                            );
                                                                            toast.info(
                                                                                "Email copied to clipboard.",
                                                                            );
                                                                        } catch {
                                                                            toast.error(
                                                                                "Failed to copy email",
                                                                            );
                                                                        }
                                                                    }}
                                                                >
                                                                    Copy Email
                                                                </DropdownMenuItem>
                                                                <DropdownMenuItem
                                                                    disabled={
                                                                        !resumeUrls[
                                                                            activeApp
                                                                                .id
                                                                        ]
                                                                    }
                                                                    onClick={() =>
                                                                        window.open(
                                                                            resumeUrls[
                                                                                activeApp
                                                                                    .id
                                                                            ],
                                                                            "_blank",
                                                                        )
                                                                    }
                                                                >
                                                                    Open Resume
                                                                </DropdownMenuItem>
                                                            </DropdownMenuContent>
                                                        </DropdownMenu>
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            className="h-8 w-8"
                                                            title="Close applicant panel"
                                                            onClick={
                                                                closeApplicant
                                                            }
                                                        >
                                                            <XIcon />
                                                        </Button>
                                                    </div>
                                                </div>

                                                <TabsList className="mt-4 w-full">
                                                    <TabsTrigger value="overview">
                                                        Overview
                                                    </TabsTrigger>
                                                    <TabsTrigger value="applications">
                                                        Applications
                                                    </TabsTrigger>
                                                    <TabsTrigger value="notes">
                                                        My Notes
                                                    </TabsTrigger>
                                                    <TabsTrigger value="history">
                                                        History
                                                    </TabsTrigger>
                                                </TabsList>
                                            </div>

                                            <ScrollArea className="min-h-0 flex-1">
                                                <div className="p-4 pb-6">
                                                    {/* Overview */}
                                                    <TabsContent
                                                        value="overview"
                                                        className="mt-0 space-y-5 data-[state=inactive]:hidden"
                                                    >
                                                        <Card
                                                            className={
                                                                SECTION_CARD
                                                            }
                                                        >
                                                            <CardHeader className="px-4">
                                                                <CardTitle className="text-base">
                                                                    About
                                                                </CardTitle>
                                                            </CardHeader>
                                                            <CardContent className="px-4">
                                                                {/* TODO(endpoint): The mock also shows School,
                                                                    Graduation and Major, but applicant profiles
                                                                    don't store them yet. LinkedIn and GitHub are
                                                                    shown in their place. */}
                                                                <div className="grid grid-cols-[105px_1fr] gap-y-2 text-sm">
                                                                    <div className="text-muted-foreground">
                                                                        Name
                                                                    </div>
                                                                    <div>
                                                                        {
                                                                            selectedApplicant.name
                                                                        }
                                                                    </div>
                                                                    <div className="text-muted-foreground">
                                                                        Email
                                                                    </div>
                                                                    <div className="break-all">
                                                                        {activeEmail ||
                                                                            "—"}
                                                                    </div>
                                                                    <div className="text-muted-foreground">
                                                                        LinkedIn
                                                                    </div>
                                                                    <div className="break-all">
                                                                        {activeDetails
                                                                            ?.profile
                                                                            ?.linkedinUrl ? (
                                                                            <a
                                                                                href={
                                                                                    activeDetails
                                                                                        .profile
                                                                                        .linkedinUrl
                                                                                }
                                                                                target="_blank"
                                                                                rel="noreferrer"
                                                                                className="text-blue-500 hover:underline"
                                                                            >
                                                                                Profile
                                                                                ↗
                                                                            </a>
                                                                        ) : (
                                                                            "—"
                                                                        )}
                                                                    </div>
                                                                    <div className="text-muted-foreground">
                                                                        GitHub
                                                                    </div>
                                                                    <div className="break-all">
                                                                        {activeDetails
                                                                            ?.profile
                                                                            ?.githubUrl ? (
                                                                            <a
                                                                                href={
                                                                                    activeDetails
                                                                                        .profile
                                                                                        .githubUrl
                                                                                }
                                                                                target="_blank"
                                                                                rel="noreferrer"
                                                                                className="text-blue-500 hover:underline"
                                                                            >
                                                                                Profile
                                                                                ↗
                                                                            </a>
                                                                        ) : (
                                                                            "—"
                                                                        )}
                                                                    </div>
                                                                    <div className="text-muted-foreground">
                                                                        Resume
                                                                    </div>
                                                                    <div>
                                                                        {resumeUrls[
                                                                            activeApp
                                                                                .id
                                                                        ] ? (
                                                                            <a
                                                                                href={
                                                                                    resumeUrls[
                                                                                        activeApp
                                                                                            .id
                                                                                    ]
                                                                                }
                                                                                target="_blank"
                                                                                rel="noreferrer"
                                                                                className="text-blue-500 hover:underline"
                                                                            >
                                                                                {
                                                                                    selectedApplicant.name.split(
                                                                                        " ",
                                                                                    )[0]
                                                                                }
                                                                                's
                                                                                Resume
                                                                                ↗
                                                                            </a>
                                                                        ) : (
                                                                            "—"
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </CardContent>
                                                        </Card>

                                                        <Card
                                                            className={
                                                                SECTION_CARD
                                                            }
                                                        >
                                                            <CardHeader className="px-4">
                                                                <CardTitle className="text-base">
                                                                    Application
                                                                    Overview
                                                                </CardTitle>
                                                            </CardHeader>
                                                            <CardContent className="px-4">
                                                                <div className="grid grid-cols-2 gap-3">
                                                                    {[
                                                                        {
                                                                            label: "Role Applied",
                                                                            value: (
                                                                                <span className="text-sm font-semibold">
                                                                                    {activeApp.rolePreferences
                                                                                        .map(
                                                                                            (
                                                                                                p,
                                                                                            ) =>
                                                                                                p.role,
                                                                                        )
                                                                                        .join(
                                                                                            ", ",
                                                                                        )}
                                                                                </span>
                                                                            ),
                                                                        },
                                                                        {
                                                                            label: "Team / Org",
                                                                            value: (
                                                                                <span className="text-sm font-semibold">
                                                                                    {
                                                                                        activeApp.teamName
                                                                                    }
                                                                                </span>
                                                                            ),
                                                                        },
                                                                        {
                                                                            label: "Applied Date",
                                                                            value: (
                                                                                <span className="text-sm font-semibold">
                                                                                    {formatLongDate(
                                                                                        activeApp.appliedAt,
                                                                                    )}
                                                                                </span>
                                                                            ),
                                                                        },
                                                                        {
                                                                            label: "Status",
                                                                            value: renderStageBadge(
                                                                                activeApp.stage,
                                                                            ),
                                                                        },
                                                                    ].map(
                                                                        (
                                                                            item,
                                                                        ) => (
                                                                            <div
                                                                                key={
                                                                                    item.label
                                                                                }
                                                                                className="border rounded-md p-3"
                                                                            >
                                                                                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                                                                                    {
                                                                                        item.label
                                                                                    }
                                                                                </div>
                                                                                {
                                                                                    item.value
                                                                                }
                                                                            </div>
                                                                        ),
                                                                    )}
                                                                </div>
                                                            </CardContent>
                                                        </Card>

                                                        <Card
                                                            className={
                                                                SECTION_CARD
                                                            }
                                                        >
                                                            <CardHeader className="px-4">
                                                                <CardTitle className="text-base">
                                                                    Application
                                                                    Responses
                                                                </CardTitle>
                                                            </CardHeader>
                                                            <CardContent className="px-4">
                                                                {activeDetails ? (
                                                                    <Accordion
                                                                        type="single"
                                                                        collapsible
                                                                    >
                                                                        {[
                                                                            [
                                                                                "Why are you interested in joining App Dev?",
                                                                                activeDetails
                                                                                    .profile
                                                                                    ?.whyAppDev,
                                                                            ],
                                                                            [
                                                                                "Do you follow App Dev on Instagram?",
                                                                                activeDetails
                                                                                    .profile
                                                                                    ?.instagramFollow,
                                                                            ],
                                                                            [
                                                                                "Is there something else you'd like to tell us?",
                                                                                activeDetails
                                                                                    .profile
                                                                                    ?.additionalInfo,
                                                                            ],
                                                                            ...Object.entries(
                                                                                activeDetails.responses ??
                                                                                    {},
                                                                            ),
                                                                        ]
                                                                            .filter(
                                                                                ([
                                                                                    ,
                                                                                    answer,
                                                                                ]) =>
                                                                                    !!answer,
                                                                            )
                                                                            .map(
                                                                                (
                                                                                    [
                                                                                        question,
                                                                                        answer,
                                                                                    ],
                                                                                    i,
                                                                                ) => (
                                                                                    <AccordionItem
                                                                                        key={
                                                                                            question
                                                                                        }
                                                                                        value={`response-${i}`}
                                                                                    >
                                                                                        <AccordionTrigger className="text-sm">
                                                                                            {
                                                                                                question
                                                                                            }
                                                                                        </AccordionTrigger>
                                                                                        <AccordionContent className="text-sm text-muted-foreground whitespace-pre-wrap">
                                                                                            {
                                                                                                answer
                                                                                            }
                                                                                        </AccordionContent>
                                                                                    </AccordionItem>
                                                                                ),
                                                                            )}
                                                                    </Accordion>
                                                                ) : detailsFailed[
                                                                      activeApp
                                                                          .id
                                                                  ] ? (
                                                                    <p className="text-sm text-muted-foreground">
                                                                        Failed
                                                                        to load
                                                                        details.
                                                                    </p>
                                                                ) : (
                                                                    <Loader2Icon className="animate-spin h-6 w-6 mx-auto text-muted-foreground" />
                                                                )}
                                                            </CardContent>
                                                        </Card>

                                                        <Card
                                                            className={
                                                                SECTION_CARD
                                                            }
                                                        >
                                                            <CardHeader className="px-4">
                                                                <CardTitle className="text-base">
                                                                    Applications
                                                                </CardTitle>
                                                                <CardAction>
                                                                    <Button
                                                                        variant="outline"
                                                                        size="sm"
                                                                        onClick={() =>
                                                                            setDetailTab(
                                                                                "applications",
                                                                            )
                                                                        }
                                                                    >
                                                                        View All
                                                                    </Button>
                                                                </CardAction>
                                                            </CardHeader>
                                                            <CardContent className="px-4 space-y-2">
                                                                {selectedApplicant.apps.map(
                                                                    (app) => (
                                                                        <div
                                                                            key={
                                                                                app.id
                                                                            }
                                                                            className="border rounded-md p-3 bg-background flex items-center justify-between gap-3"
                                                                        >
                                                                            <div className="min-w-0">
                                                                                <div className="font-semibold text-sm">
                                                                                    {
                                                                                        app.teamName
                                                                                    }
                                                                                </div>
                                                                                <div className="text-xs text-muted-foreground mt-1">
                                                                                    {app.rolePreferences
                                                                                        .map(
                                                                                            (
                                                                                                p,
                                                                                            ) => {
                                                                                                const title =
                                                                                                    formatRolePreferenceLabel(
                                                                                                        p,
                                                                                                    );
                                                                                                const sub =
                                                                                                    p.subteamName?.trim();
                                                                                                if (
                                                                                                    sub &&
                                                                                                    title !==
                                                                                                        sub
                                                                                                ) {
                                                                                                    return `${title} (${sub})`;
                                                                                                }
                                                                                                return title;
                                                                                            },
                                                                                        )
                                                                                        .join(
                                                                                            " · ",
                                                                                        )}
                                                                                </div>
                                                                            </div>
                                                                            <div className="flex items-center gap-2">
                                                                                <span className="text-[11px] text-muted-foreground">
                                                                                    {
                                                                                        app
                                                                                            .rolePreferences
                                                                                            .length
                                                                                    }{" "}
                                                                                    role
                                                                                    {app
                                                                                        .rolePreferences
                                                                                        .length ===
                                                                                    1
                                                                                        ? ""
                                                                                        : "s"}
                                                                                </span>
                                                                                {renderStageBadge(
                                                                                    app.stage,
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                    ),
                                                                )}
                                                            </CardContent>
                                                        </Card>
                                                    </TabsContent>

                                                    {/* Applications */}
                                                    <TabsContent
                                                        value="applications"
                                                        className="mt-0 space-y-4 data-[state=inactive]:hidden"
                                                    >
                                                        <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                                                            Applied
                                                            Organizations
                                                        </div>
                                                        {selectedApplicant.apps.map(
                                                            (app) => {
                                                                const isActive =
                                                                    app.id ===
                                                                    activeApp.id;
                                                                const activeRoleKey =
                                                                    activeRoles[
                                                                        app.id
                                                                    ] ??
                                                                    app
                                                                        .rolePreferences[0]
                                                                        ?.role;
                                                                const activePref =
                                                                    app.rolePreferences.find(
                                                                        (p) =>
                                                                            p.role ===
                                                                            activeRoleKey,
                                                                    ) ??
                                                                    app
                                                                        .rolePreferences[0];
                                                                const activeRoleLabel =
                                                                    activePref
                                                                        ? formatRolePreferenceLabel(
                                                                              activePref,
                                                                          )
                                                                        : "—";
                                                                const subteamLabel =
                                                                    activePref?.subteamName?.trim() ||
                                                                    openTeams
                                                                        .find(
                                                                            (
                                                                                t,
                                                                            ) =>
                                                                                t.teamPk ===
                                                                                app.teamPk,
                                                                        )
                                                                        ?.subteamInfo?.[
                                                                        activePref?.subteamPk ??
                                                                            ""
                                                                    ]
                                                                        ?.friendlyName ||
                                                                    "—";
                                                                const roleDescription =
                                                                    openTeams.find(
                                                                        (t) =>
                                                                            t.teamPk ===
                                                                            app.teamPk,
                                                                    )
                                                                        ?.subteamInfo?.[
                                                                        activePref?.subteamPk ??
                                                                            ""
                                                                    ]
                                                                        ?.description ||
                                                                    activePref?.subteamName
                                                                        ? `${activeRoleLabel} on the ${activePref.subteamName} subteam. Open the team recruitment view for full responses and materials.`
                                                                        : "Open the team recruitment view for this applicant's responses and materials.";

                                                                return (
                                                                    <Card
                                                                        key={
                                                                            app.id
                                                                        }
                                                                        className={cn(
                                                                            "gap-0 py-0 shadow-none",
                                                                            isActive
                                                                                ? "border-primary/60 bg-muted/50"
                                                                                : "bg-muted/20",
                                                                        )}
                                                                    >
                                                                        <div className="px-4 py-3">
                                                                            <div className="flex items-center justify-between gap-3">
                                                                                <button
                                                                                    type="button"
                                                                                    className="min-w-0 text-left text-sm font-semibold leading-snug"
                                                                                    onClick={() =>
                                                                                        setActiveAppId(
                                                                                            app.id,
                                                                                        )
                                                                                    }
                                                                                >
                                                                                    {
                                                                                        app.teamName
                                                                                    }
                                                                                </button>
                                                                                <Badge variant="outline">
                                                                                    {
                                                                                        app
                                                                                            .rolePreferences
                                                                                            .length
                                                                                    }{" "}
                                                                                    role
                                                                                    {app
                                                                                        .rolePreferences
                                                                                        .length ===
                                                                                    1
                                                                                        ? ""
                                                                                        : "s"}
                                                                                </Badge>
                                                                            </div>
                                                                            {app
                                                                                .rolePreferences
                                                                                .length >
                                                                                0 && (
                                                                                <div className="mt-3 flex flex-wrap gap-2">
                                                                                    {app.rolePreferences.map(
                                                                                        (
                                                                                            pref,
                                                                                        ) => {
                                                                                            const isSelectedRole =
                                                                                                isActive &&
                                                                                                pref.role ===
                                                                                                    activeRoleKey;
                                                                                            return (
                                                                                                <Button
                                                                                                    key={`${app.id}-${pref.subteamPk}-${pref.role}`}
                                                                                                    size="sm"
                                                                                                    className="h-auto min-h-7 max-w-full whitespace-normal px-2.5 py-1 text-xs text-left"
                                                                                                    variant={
                                                                                                        isSelectedRole
                                                                                                            ? "secondary"
                                                                                                            : "outline"
                                                                                                    }
                                                                                                    onClick={() => {
                                                                                                        setActiveAppId(
                                                                                                            app.id,
                                                                                                        );
                                                                                                        setActiveRoles(
                                                                                                            (
                                                                                                                prev,
                                                                                                            ) => ({
                                                                                                                ...prev,
                                                                                                                [app.id]:
                                                                                                                    pref.role,
                                                                                                            }),
                                                                                                        );
                                                                                                    }}
                                                                                                >
                                                                                                    <span className="font-medium">
                                                                                                        {formatRolePreferenceLabel(
                                                                                                            pref,
                                                                                                        )}
                                                                                                    </span>
                                                                                                    {pref.subteamName &&
                                                                                                    formatRolePreferenceLabel(
                                                                                                        pref,
                                                                                                    ) !==
                                                                                                        pref.subteamName.trim() ? (
                                                                                                        <span className="ml-1 font-normal text-muted-foreground">
                                                                                                            (
                                                                                                            {
                                                                                                                pref.subteamName
                                                                                                            }
                                                                                                            )
                                                                                                        </span>
                                                                                                    ) : null}
                                                                                                </Button>
                                                                                            );
                                                                                        },
                                                                                    )}
                                                                                </div>
                                                                            )}
                                                                        </div>

                                                                        {isActive && (
                                                                            <div className="space-y-4 border-t bg-muted/30 px-4 py-4">
                                                                                <div className="flex items-start justify-between gap-3">
                                                                                    <div className="min-w-0">
                                                                                        <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                                                                                            Selected
                                                                                            role
                                                                                        </div>
                                                                                        <div className="text-sm font-semibold leading-snug">
                                                                                            {
                                                                                                activeRoleLabel
                                                                                            }
                                                                                        </div>
                                                                                        <div className="mt-1 text-xs text-muted-foreground">
                                                                                            Subteam:{" "}
                                                                                            {
                                                                                                subteamLabel
                                                                                            }
                                                                                        </div>
                                                                                    </div>
                                                                                    <Button
                                                                                        variant="outline"
                                                                                        size="sm"
                                                                                        className="shrink-0"
                                                                                        onClick={() =>
                                                                                            navigate(
                                                                                                `/org/teams/${app.teamPk}/recruitment`,
                                                                                            )
                                                                                        }
                                                                                    >
                                                                                        View
                                                                                        Application
                                                                                    </Button>
                                                                                </div>
                                                                                <p className="text-sm leading-6 text-muted-foreground">
                                                                                    {
                                                                                        roleDescription
                                                                                    }
                                                                                </p>
                                                                                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t pt-3 text-sm">
                                                                                    <div className="text-muted-foreground">
                                                                                        Applied
                                                                                    </div>
                                                                                    <div>
                                                                                        {formatLongDate(
                                                                                            app.appliedAt,
                                                                                        )}
                                                                                    </div>
                                                                                    <div className="text-muted-foreground">
                                                                                        Status
                                                                                    </div>
                                                                                    <div>
                                                                                        {renderStageBadge(
                                                                                            app.stage,
                                                                                        )}
                                                                                    </div>
                                                                                    {app.hiredRole ? (
                                                                                        <>
                                                                                            <div className="text-muted-foreground">
                                                                                                Hired
                                                                                                role
                                                                                            </div>
                                                                                            <div>
                                                                                                {
                                                                                                    app.hiredRole
                                                                                                }
                                                                                            </div>
                                                                                        </>
                                                                                    ) : null}
                                                                                    <div className="text-muted-foreground">
                                                                                        Rating
                                                                                    </div>
                                                                                    <div className="flex items-center gap-1">
                                                                                        <Ratings
                                                                                            variant="yellow"
                                                                                            totalStars={
                                                                                                5
                                                                                            }
                                                                                            value={
                                                                                                app.stars ??
                                                                                                0
                                                                                            }
                                                                                            size={
                                                                                                14
                                                                                            }
                                                                                        />
                                                                                        {app.stars ===
                                                                                        0 ? (
                                                                                            <span className="text-xs text-muted-foreground">
                                                                                                Not
                                                                                                rated
                                                                                                (see
                                                                                                team
                                                                                                board)
                                                                                            </span>
                                                                                        ) : null}
                                                                                    </div>
                                                                                </div>
                                                                                <p className="text-[11px] leading-relaxed text-muted-foreground">
                                                                                    Question
                                                                                    responses,
                                                                                    resume,
                                                                                    notes,
                                                                                    and
                                                                                    stage
                                                                                    history
                                                                                    for
                                                                                    this
                                                                                    application
                                                                                    are
                                                                                    on
                                                                                    Overview,
                                                                                    My
                                                                                    Notes,
                                                                                    and
                                                                                    History
                                                                                    tabs,
                                                                                    or
                                                                                    in
                                                                                    the
                                                                                    team
                                                                                    recruitment
                                                                                    view.
                                                                                </p>
                                                                            </div>
                                                                        )}
                                                                    </Card>
                                                                );
                                                            },
                                                        )}
                                                    </TabsContent>

                                                    {/* My Notes */}
                                                    <TabsContent
                                                        value="notes"
                                                        className="mt-0 space-y-4 data-[state=inactive]:hidden"
                                                    >
                                                        <div className="flex items-center justify-between">
                                                            <div>
                                                                <div className="font-semibold">
                                                                    My Private
                                                                    Notes
                                                                </div>
                                                                <div className="text-xs text-muted-foreground mt-1">
                                                                    Only visible
                                                                    to you
                                                                </div>
                                                            </div>
                                                            <div className="text-xs text-muted-foreground">
                                                                Reviewer
                                                                workspace
                                                            </div>
                                                        </div>
                                                        <Textarea
                                                            rows={10}
                                                            placeholder="Write your notes about this applicant..."
                                                            value={notesText}
                                                            onChange={(e) =>
                                                                setNotesText(
                                                                    e.target
                                                                        .value,
                                                                )
                                                            }
                                                        />
                                                        <div className="flex justify-end gap-2">
                                                            <Button
                                                                variant="outline"
                                                                onClick={() =>
                                                                    setNotesText(
                                                                        savedNotesText,
                                                                    )
                                                                }
                                                            >
                                                                Cancel
                                                            </Button>
                                                            <Button
                                                                onClick={
                                                                    saveNotes
                                                                }
                                                            >
                                                                Save Notes
                                                            </Button>
                                                        </div>
                                                        <div className="text-[11px] text-muted-foreground text-right">
                                                            {notesState}
                                                        </div>
                                                    </TabsContent>

                                                    {/* History */}
                                                    <TabsContent
                                                        value="history"
                                                        className="mt-0 space-y-4 data-[state=inactive]:hidden"
                                                    >
                                                        <div className="font-semibold">
                                                            Application Timeline
                                                        </div>
                                                        <Card
                                                            className={
                                                                SECTION_CARD
                                                            }
                                                        >
                                                            <CardContent className="px-4">
                                                                {activeDetails ? (
                                                                    <Timeline size="sm">
                                                                        {activeDetails.stageHistory
                                                                            ?.slice()
                                                                            .map(
                                                                                (
                                                                                    history,
                                                                                    index,
                                                                                ) => (
                                                                                    <TimelineItem
                                                                                        key={
                                                                                            index
                                                                                        }
                                                                                        date={new Date(
                                                                                            history.changedAt,
                                                                                        ).toLocaleString()}
                                                                                        title={
                                                                                            history.stage
                                                                                        }
                                                                                        icon={getTimelineStageIcon(
                                                                                            history.stage,
                                                                                        )}
                                                                                        iconColor={
                                                                                            STAGE_STYLES[
                                                                                                history
                                                                                                    .stage
                                                                                            ]
                                                                                        }
                                                                                        description={`Changed by ${history.changedBy || "System"}`}
                                                                                    />
                                                                                ),
                                                                            )}
                                                                    </Timeline>
                                                                ) : detailsFailed[
                                                                      activeApp
                                                                          .id
                                                                  ] ? (
                                                                    <p className="text-sm text-muted-foreground">
                                                                        Failed
                                                                        to load
                                                                        history.
                                                                    </p>
                                                                ) : (
                                                                    <Loader2Icon className="animate-spin h-6 w-6 mx-auto text-muted-foreground" />
                                                                )}
                                                            </CardContent>
                                                        </Card>

                                                        <div className="font-semibold">
                                                            Quick Actions
                                                        </div>
                                                        <div className="grid grid-cols-1 gap-2">
                                                            <Button
                                                                variant="outline"
                                                                onClick={() =>
                                                                    window.open(
                                                                        `/org/teams/${activeApp.teamPk}/recruitment`,
                                                                        "_blank",
                                                                    )
                                                                }
                                                            >
                                                                Open in New Tab
                                                                <ExternalLinkIcon />
                                                            </Button>
                                                            <Button
                                                                variant="outline"
                                                                onClick={() =>
                                                                    navigate(
                                                                        `/org/teams/${activeApp.teamPk}/recruitment`,
                                                                    )
                                                                }
                                                            >
                                                                View Application
                                                            </Button>
                                                            <Button
                                                                onClick={() =>
                                                                    setDetailTab(
                                                                        "notes",
                                                                    )
                                                                }
                                                            >
                                                                My Notes
                                                            </Button>
                                                        </div>
                                                    </TabsContent>
                                                </div>
                                            </ScrollArea>
                                        </Tabs>
                                    </Card>
                                </>
                            )}
                    </div>
                </div>
            </div>
        </div>
    );
};
