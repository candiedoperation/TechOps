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

import { PEOPLEPORTAL_SERVER_ENDPOINT } from "@/commons/config";
import React from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { TeamInfo } from "./DashboardTeamInfo";
import { RecruitmentStatistics } from "./RecruitmentStatistics";
import { NavLink, useParams, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRecruitmentQueries, type RecruitmentApplication, type StageFields } from "./recruitment-queries";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion";
import { Switch } from "../ui/switch";
import { Label } from "../ui/label";
import { TagInput, type Tag } from 'emblor-maintained';
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Loader2, Loader2Icon, ExternalLinkIcon, ChevronLeft, ChevronRight, MailIcon, ClipboardCheckIcon, PartyPopperIcon, HeadsetIcon, CopyCheckIcon, ThumbsDownIcon, AlertTriangleIcon, MessageSquarePlusIcon } from "lucide-react";
import { KanbanBoard, KanbanCard, KanbanCards, KanbanHeader, KanbanProvider } from "../ui/shadcn-io/kanban";
import type { DragEndEvent } from "@dnd-kit/core";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DialogFooter } from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { Timeline, TimelineItem } from "../ui/timeline";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import Ratings from "../ui/ratings";
import { Editor } from "@/components/blocks/editor-00/editor";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface SubteamATSConfig {
    roles: string[]
    roleSpecificQuestions: { [key: string]: string[] },
    isRecruiting: boolean
}

interface StageDefinition {
    id: string;
    name: string;
    [key: string]: unknown;  // Index signature for Kanban compatibility
}

/** Recruitment cache is private to this mounted team/reviewer, never persisted. */
export const DashboardTeamRecruitment = ({ reviewerId }: { reviewerId: number }) => {
    const { teamId } = useParams();
    if (!teamId) return null;
    return <RecruitmentSession key={`${reviewerId}:${teamId}`} teamId={teamId} />;
};

function RecruitmentSession({ teamId }: { teamId: string }) {
    const [client] = React.useState(() => new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 10 * 60_000 },
            mutations: { retry: false },
        },
    }));
    React.useEffect(() => () => client.clear(), [client]);
    return <QueryClientProvider client={client}><RecruitmentBoard teamId={teamId} /></QueryClientProvider>;
}

function RecruitmentBoard({ teamId }: { teamId: string }) {
    const STAGE_STYLES: { [key: string]: string } = {
        'Applied': 'text-blue-700 bg-blue-50 border-blue-200',
        'Interview': 'text-purple-700 bg-purple-50 border-purple-200',
        'Hired': 'text-green-700 bg-green-50 border-green-200',
        'Rejected': 'text-red-700 bg-red-50 border-red-200',
        'Potential Hire': 'text-orange-700 bg-orange-50 border-orange-200',
    }
    const [searchParams, setSearchParams] = useSearchParams();
    const selectedId = searchParams.get("application");
    const review = useRecruitmentQueries(teamId, selectedId);
    const applications = review.applications.data ?? [];
    const selectedApplication = review.selected;
    const selectedApplicationDetails = review.details.data;
    const resumeUrl = review.resume.data && review.resume.data.refreshAt > Date.now()
        ? review.resume.data.resumeUrl : undefined;

    function selectApplication(id: string | null) {
        setSearchParams(current => {
            const next = new URLSearchParams(current);
            if (id === null) next.delete("application");
            else next.set("application", id);
            return next;
        });
    }
    const [teamInfo, setTeamInfo] = React.useState<TeamInfo>();
    const [subTeams, setSubTeams] = React.useState<TeamInfo[]>([]);
    const [stages, setStages] = React.useState<StageDefinition[]>([]);

    const [roles, setRoles] = React.useState<{ [key: string]: Tag[] }>({});
    const [tagIndex, setTagIndex] = React.useState<{ [key: string]: number | null }>({});

    const [isLoading, setIsLoading] = React.useState(false);
    const [recruitmentEnabled, setRecruitmentEnabled] = React.useState<{ [key: string]: boolean }>({})
    const [roleSpecQuestions, setRoleSpecQuestions] = React.useState<{ [key: string]: { [key: string]: string[] } }>({})

    // --- Stage Transition Logic ---
    const VALID_TRANSITIONS: { [key: string]: string[] } = {
        'Applied': ['Interview', 'Rejected'],
        'Interview': ['Potential Hire', 'Hired', 'Rejected', 'Rejected After Interview'],
        'Potential Hire': ['Hired', 'Rejected'],
        // Terminal stages cannot transition anywhere
        'Hired': [],
        'Rejected': [],
        'Rejected After Interview': []
    }

    const [pendingTransition, setPendingTransition] = React.useState<{ applicationId: string, newStage: string } | null>(null)
    const actionDialog = pendingTransition?.newStage === 'Rejected' || pendingTransition?.newStage === 'Rejected After Interview'
        ? 'reject' : pendingTransition?.newStage === 'Interview' ? 'interview'
        : pendingTransition?.newStage === 'Potential Hire' ? 'potential'
        : pendingTransition?.newStage === 'Hired' ? 'hired' : null;

    // Dialog Inputs
    const [interviewLink, setInterviewLink] = React.useState("")
    const [saveInteviewLink, setSaveInterviewLink] = React.useState(false)
    const [interviewGuidelines, setInterviewGuidelines] = React.useState("")
    const [saveInterviewGuidelines, setSaveInterviewGuidelines] = React.useState(false)
    const [hiredRole, setHiredRole] = React.useState("")

    // Feedback Dialog State
    const [feedbackDraft, setFeedbackDraft] = React.useState<{ applicationId: string; name: string; text: string } | null>(null);
    const feedbackDialogOpen = feedbackDraft !== null && feedbackDraft.applicationId === selectedId;
    const isFeedbackSubmitting = review.isFeedbackPending;
    const isStageSubmitting = review.stage.isPending;

    // URL navigation also dismisses an unsaved editor, including browser Back/Forward.
    React.useEffect(() => { setFeedbackDraft(null); }, [selectedId]);


    // Update browser tab title when an application is opened/closed
    React.useEffect(() => {
        if (selectedApplication) {
            document.title = `${selectedApplication.name} - ${teamInfo?.attributes?.friendlyName ?? "App Dev Club"}`
        } else {
            document.title = "App Dev Club People Portal"
        }
        
        return () => {
            document.title = "App Dev Club People Portal"
        }
    }, [selectedApplication, teamInfo])

    // Load saved interview link on mount
    React.useEffect(() => {
        const saved = localStorage.getItem("interviewLink")
        if (saved) {
            setInterviewLink(saved)
            setSaveInterviewLink(true)
        }

        const savedGuidelines = localStorage.getItem("interviewGuidelines")
        if (savedGuidelines) {
            setInterviewGuidelines(savedGuidelines)
            setSaveInterviewGuidelines(true)
        }
    }, [])

    function validateTransition(currentStage: string, newStage: string): boolean {
        // Allow same stage (no-op)
        if (currentStage === newStage) return true;

        const allowed = VALID_TRANSITIONS[currentStage] || [];
        // If current stage isn't in definition, assume it's terminal or stuck (prevent move)
        // Unless it's a super-user/admin override, but we stick to rules:
        return allowed.includes(newStage);
    }

    // Unified handler for both Drag & Drop and Button clicks
    function initiateStageUpdate(applicationId: string, currentStage: string, newStage: string) {
        if (currentStage === newStage || isStageSubmitting) return;
        // 1. Validate
        if (!validateTransition(currentStage, newStage)) {
            toast.error("Invalid Stage Transition", {
                description: `Cannot move from "${currentStage}" to "${newStage}".`
            });
            return;
        }

        setHiredRole("");
        setPendingTransition({ applicationId, newStage });
    }

    function handleStarRating(stars: number) {
        if (!selectedApplication || isFeedbackSubmitting) return;
        void review.feedback.mutateAsync({ applicationId: selectedApplication.id, stars })
            .catch(error => toast.error(`Failed to update rating: ${error.message}`));
    }

    async function handleFeedbackSubmit() {
        const draft = feedbackDraft;
        if (!draft || !draft.text.trim() || isFeedbackSubmitting) return;
        try {
            await review.feedback.mutateAsync({ applicationId: draft.applicationId, notes: draft.text });
            toast.success(`Updated feedback for ${draft.name}`);
            setFeedbackDraft(current => current === draft ? null : current);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to add feedback.");
        }
    }

    async function executeStageUpdate(applicationId: string, newStage: string, extraData: StageFields = {}) {
        if (review.stage.isPending) return;
        const transition = pendingTransition;
        try {
            await review.stage.mutateAsync({ applicationId, stage: newStage, ...extraData });
            const app = applications.find(application => application.id === applicationId);
            toast.success("Stage Updated", { description: `Moved ${app?.name} to ${newStage}` });
            // Do not dismiss a different confirmation opened while this request was pending.
            setPendingTransition(current => current === transition ? null : current);

            if (extraData.interviewLink && saveInteviewLink) {
                localStorage.setItem("interviewLink", extraData.interviewLink);
            } else if (!saveInteviewLink) {
                localStorage.removeItem("interviewLink");
            }
            if (extraData.interviewGuidelines && saveInterviewGuidelines) {
                localStorage.setItem("interviewGuidelines", extraData.interviewGuidelines);
            } else if (!saveInterviewGuidelines) {
                localStorage.removeItem("interviewGuidelines");
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to update stage.");
        }
    }

    function cancelStageUpdate() {
        setPendingTransition(null);
        setHiredRole("");
    }

    function handleDragEnd(event: DragEndEvent) {
        const { active, over } = event;
        if (!over) return;
        const app = applications.find(a => a.id === active.id);
        const targetStage = applications.find(a => a.id === over.id)?.stage
            ?? stages.find(stage => stage.id === over.id)?.id;
        if (app && targetStage) {
            initiateStageUpdate(app.id, app.stage, targetStage);
        }
    }

    // Fetch application stages
    React.useEffect(() => {
        fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/stages`)
            .then(async (response) => {
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.message || "Failed to fetch stages");
                }
                const data = await response.json();
                setStages(data);
            })
            .catch((e) => {
                console.error("Failed to fetch stages:", e);
                toast.error("Failed to load application stages: " + e.message);
            });
    }, []);

    React.useEffect(() => {
        fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/org/teams/${teamId}`)
            .then(async (response) => {
                const teamlistResponse: any = await response.json()
                if (!response.ok)
                    throw new Error(teamlistResponse.message || "Failed to fetch");

                setTeamInfo(teamlistResponse.team)
                setSubTeams(teamlistResponse.subteams)

                for (const subteam of teamlistResponse.subteams) {
                    fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/config/${subteam.pk}`)
                        .then(async (response) => {
                            if (response.ok) {
                                const config: SubteamATSConfig = await response.json()
                                const mappedRoles = config.roles.map((role, index) => ({ id: index.toString(), text: role } as Tag))
                                setRoles(role => ({ ...role, [subteam.pk]: mappedRoles }))
                                setTagIndex(tagIndex => ({ ...tagIndex, [subteam.pk]: null }))
                                setRecruitmentEnabled(enabled => ({ ...enabled, [subteam.pk]: config.isRecruiting }))
                                setRoleSpecQuestions(rsq => ({ ...rsq, [subteam.pk]: config.roleSpecificQuestions }))
                            } else if (response.status == 404) {
                                setRoles(role => ({ ...role, [subteam.pk]: [] }))
                                setTagIndex(tagIndex => ({ ...tagIndex, [subteam.pk]: null }))
                                setRecruitmentEnabled(enabled => ({ ...enabled, [subteam.pk]: false }))
                                setRoleSpecQuestions(rsq => ({ ...rsq, [subteam.pk]: {} }))
                            } else {
                                // toast.error("Failed to Fetch Configuration", "We couldn't ret")
                            }

                            /* Update Role Specific Questions & Enabled Status */
                        })
                }
            })

            .catch((e) => {
                toast.error("Failed to Fetch Team Information: " + e.message)
            })
    }, [teamId]);

    function handleSettingsUpdate(subteamPk: string) {
        setIsLoading(true);
        const enabledRoles = roles[subteamPk].map((role) => role.text)
        const questions = enabledRoles.reduce(
            (acc: { [key: string]: string[] }, role) => {
                acc[role] = roleSpecQuestions[subteamPk][role]
                return acc
            }, {}
        )

        fetch(`${PEOPLEPORTAL_SERVER_ENDPOINT}/api/ats/config/${subteamPk}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                isRecruiting: recruitmentEnabled[subteamPk],
                roles: enabledRoles,
                roleSpecificQuestions: questions
            })
        }).then(async (res) => {
            if (!res.ok) {
                const errorData = await res.json();
                throw new Error(errorData.message || `HTTP ${res.status}`);
            }
            toast.success("Configuration Saved", {
                description: "Subteam Recruitment Settings have been Updated!"
            })
        }).catch((e) => {
            toast.error("Server Failure", {
                description: "Failed to Save Settings: " + e.message
            })
        }).finally(() => {
            /* Stop Button loading */
            setIsLoading(false)
        })
    }

    // --- Navigation Logic ---
    const reviewableStages = ['Applied', 'Interview', 'Potential Hire'];
    const reviewableApps = applications
        .filter(a => reviewableStages.includes(a.stage))
        .sort((a, b) => {
            const idxA = reviewableStages.indexOf(a.stage);
            const idxB = reviewableStages.indexOf(b.stage);
            return idxA - idxB;
        });
    const currentNavIndex = selectedApplication ? reviewableApps.findIndex(a => a.id === selectedApplication.id) : -1;

    function navigateApplicant(direction: 'next' | 'prev') {
        if (currentNavIndex === -1) return;
        const newIndex = direction === 'next' ? currentNavIndex + 1 : currentNavIndex - 1;
        if (newIndex >= 0 && newIndex < reviewableApps.length) {
            selectApplication(reviewableApps[newIndex].id);
        }
    }

    // --- MISC UI STUFF ---
    const getTimelineStageIcon = (stage: string) => {
        switch (stage) {
            case 'Applied':
                return <ClipboardCheckIcon />
            case 'Interview':
                return <HeadsetIcon />
            case 'Potential Hire':
                return <CopyCheckIcon />
            case 'Hired':
                return <PartyPopperIcon />
            case 'Rejected':
                return <ThumbsDownIcon />
        }
    }

    return (
        <div className="flex flex-col m-2 h-full">
            <div className="flex items-center">
                <div className="flex flex-col flex-grow-1">
                    <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight text-balance">Recruitment Tracker</h1>
                    <h4 className="text-xl text-muted-foreground">{teamInfo?.attributes.friendlyName} {`${teamInfo?.attributes.seasonType} ${teamInfo?.attributes.seasonYear}`}</h4>
                </div>
            </div>

            <Tabs className="mt-5 flex flex-col flex-grow" defaultValue="applications">
                <TabsList>
                    <TabsTrigger value="applications">Applications</TabsTrigger>
                    <TabsTrigger value="statistics">Statistics</TabsTrigger>
                    <TabsTrigger value="settings">Recruitment Settings</TabsTrigger>
                </TabsList>

                <div className="mt-2 flex-grow flex flex-col min-h-0">
                    <TabsContent className="flex flex-col flex-grow h-full" value="applications">
                        {review.applications.isPending && <p role="status">Loading applications…</p>}
                        {review.applications.isError && <div role="alert">
                            <p>{review.applications.error.message}</p>
                            <Button variant="outline" onClick={() => review.applications.refetch()}>Retry applications</Button>
                        </div>}
                        <KanbanProvider
                            columns={stages}
                            data={applications}
                            columnKey="stage"
                            // A drag proposes a transition; only a saved response changes the stage.
                            onDragEnd={handleDragEnd}
                            className="overflow-x-auto flex h-full"
                        >
                            {(/* column */ col) => {
                                const column = col as StageDefinition;
                                return (
                                    <div key={column.id} className="w-[250px] shrink-0">
                                    <KanbanBoard id={column.id} className="w-full ring-inset">
                                        <KanbanHeader>{column.name} ({applications.filter(a => a.stage === column.id).length})</KanbanHeader>
                                        <KanbanCards id={column.id}>
                                            {(item: RecruitmentApplication) => {
                                                return (
                                                    <KanbanCard
                                                        id={item.id}
                                                        name={item.name}
                                                        className="bg-background hover:bg-muted/50 transition-colors border-border p-3"
                                                        onClick={() => selectApplication(item.id)}
                                                    >
                                                        <div className="flex flex-col w-full">
                                                            <div className="flex items-baseline justify-between gap-2">
                                                                <span className="font-semibold text-xs truncate leading-tight">{item.name}</span>
                                                                <span className="text-[9px] text-muted-foreground whitespace-nowrap tabular-nums shrink-0">
                                                                    {new Date(item.appliedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                                                </span>
                                                            </div>

                                                            <div className="text-[10px] text-muted-foreground/80 truncate mt-0.5 leading-tight">
                                                                {item.rolePreferences.map(p => p.role).join(", ")}
                                                            </div>

                                                            <div className="flex items-center gap-0.5 mt-1.5">
                                                                <Ratings
                                                                    variant="yellow"
                                                                    totalStars={5}
                                                                    value={item.stars ?? 0}
                                                                    size={12}
                                                                />
                                                            </div>
                                                        </div>
                                                    </KanbanCard>
                                                );
                                            }}
                                        </KanbanCards>
                                    </KanbanBoard>
                                    </div>
                                )
                            }}
                        </KanbanProvider>
                    </TabsContent>

                    <TabsContent className="overflow-y-auto h-full" value="statistics">
                        <RecruitmentStatistics applications={applications} subTeams={subTeams} />
                    </TabsContent>

                    <TabsContent value="settings">
                        <Accordion type="single" collapsible>
                            {
                                subTeams.filter((subteam) => !subteam.attributes.flaggedForDeletion).map((subteam) => {
                                    return (
                                        <AccordionItem value={subteam.pk}>
                                            <AccordionTrigger>{subteam.attributes.friendlyName} Subteam</AccordionTrigger>
                                            <AccordionContent>
                                                <div className="flex flex-col">
                                                    <p className="text-lg text-muted-foreground">Subteam Description</p>
                                                    <p>{subteam.attributes.description}</p>

                                                    <p className="text-lg text-muted-foreground mt-5">Are you Recruiting?</p>
                                                    <div className="flex items-center space-x-2 mt-2">
                                                        <Switch checked={recruitmentEnabled[subteam.pk]} onCheckedChange={(checked) => setRecruitmentEnabled(enabled => ({ ...enabled, [subteam.pk]: checked }))} id="airplane-mode" />
                                                        <Label htmlFor="airplane-mode">Enable Recruiting for the {subteam.attributes.friendlyName.toUpperCase()} subteam</Label>
                                                    </div>

                                                    <p className="text-lg text-muted-foreground mt-5">What roles are you recruiting for?</p>
                                                    <p>Please note that the roles you define below are only for the <b>{subteam.attributes.friendlyName.toUpperCase()}</b> subteam. Here's a quick guide of sample roles, just in case you're stuck!</p>
                                                    <ul className="list-disc pl-8 pt-2">
                                                        <li>Leadership Subteams may recruit <b>Tech Leads</b></li>
                                                        <li>Engineering Subteams may recruit <b>Frontend Engineers, Full Stack Engineers, etc.</b></li>
                                                        <li>Bootcamp's Students Subteam would only recruit for the role of <b>Bootcamp Student</b></li>
                                                        <li>Social Media's Creative Subteam may recruit for <b>Poster Designers</b></li>
                                                    </ul>

                                                    <Label className="mt-5 mb-2">List Roles</Label>
                                                    <TagInput
                                                        textCase="capitalize"
                                                        placeholder="Ex. Software Engineer, ML Engineer, etc."
                                                        size={'sm'}
                                                        tags={roles[subteam.pk] || []}
                                                        setTags={(value: React.SetStateAction<Tag[]>) => {
                                                            setRoles(roles => ({
                                                                ...roles,
                                                                [subteam.pk]: (typeof value == "function") ? value(roles[subteam.pk]) : value
                                                            }))
                                                        }}

                                                        styleClasses={{
                                                            input: "h-7 pl-2 pr-2 shadow-none"
                                                        }}

                                                        activeTagIndex={tagIndex[subteam.pk] ?? null}
                                                        setActiveTagIndex={function (value: React.SetStateAction<number | null>): void {
                                                            setTagIndex(tagIndex => ({
                                                                ...tagIndex,
                                                                [subteam.pk]: (typeof value == "function") ? value(tagIndex[subteam.pk]) : value
                                                            }))
                                                        }} />

                                                    <p className="text-lg text-muted-foreground mt-5">Role Specific Questions</p>
                                                    {
                                                        (roles[subteam.pk] && roles[subteam.pk].length > 0) ?
                                                            roles[subteam.pk].map((role) => (
                                                                <div className="flex flex-col gap-2 mt-2 mb-2">
                                                                    <Label>Question for {role.text} Applicants</Label>
                                                                    <Input
                                                                        value={roleSpecQuestions[subteam.pk][role.text]?.at(0) ?? ""}
                                                                        onChange={(e) => {
                                                                            setRoleSpecQuestions(questions => ({
                                                                                ...questions,
                                                                                [subteam.pk]: {
                                                                                    ...questions[subteam.pk],
                                                                                    [role.text]: [e.target.value]
                                                                                }
                                                                            }))
                                                                        }}
                                                                    />
                                                                </div>
                                                            )) :
                                                            <p>Please Create roles in the previous section to enable Role Specific Questions</p>
                                                    }
                                                </div>

                                                <Button disabled={isLoading} onClick={() => handleSettingsUpdate(subteam.pk)} className="mt-5">
                                                    <Loader2Icon className={`animate-spin ${(!isLoading) ? "hidden" : ""}`} />
                                                    Save Changes
                                                </Button>
                                            </AccordionContent>
                                        </AccordionItem>
                                    )
                                })
                            }
                        </Accordion>
                    </TabsContent>
                </div>
            </Tabs>

            {/* Application Details Modal */}
            <Dialog open={selectedId !== null} onOpenChange={(open) => !open && selectApplication(null)}>
                <DialogContent className="!max-w-[95vw] !w-[95vw] !h-[95vh] p-0 flex gap-0">

                    {/* Left Sidebar: Application Information */}
                    <div className="w-96 bg-muted/20 border-r p-4 flex flex-col gap-4 overflow-y-auto shrink-0">
                        <div>
                            <div className="flex items-center justify-between">
                                <DialogTitle className="font-semibold text-lg">{selectedApplication?.name ?? "Application"}</DialogTitle>
                                <div className="flex gap-1">
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className="h-6 w-6"
                                        aria-label="Previous applicant"
                                        onClick={() => navigateApplicant('prev')}
                                        disabled={currentNavIndex <= 0}
                                    >
                                        <ChevronLeft className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className="h-6 w-6"
                                        aria-label="Next applicant"
                                        onClick={() => navigateApplicant('next')}
                                        disabled={currentNavIndex === -1 || currentNavIndex >= reviewableApps.length - 1}
                                    >
                                        <ChevronRight className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                            <DialogDescription>Application Information</DialogDescription>
                            <div className="flex flex-col gap-2 mt-2">
                                <Ratings
                                    onValueChange={isFeedbackSubmitting || !selectedApplication || review.details.isError ? undefined : handleStarRating}
                                    variant="yellow"
                                    totalStars={5}
                                    value={selectedApplication?.stars || 0}
                                    size={18}
                                />
                            </div>
                        </div>

                        {review.details.isPending ? (
                            <div className="flex items-center justify-center p-8">
                                <Loader2Icon aria-label="Loading application details" className="animate-spin h-8 w-8 text-muted-foreground" />
                            </div>
                        ) : !review.details.isError && selectedApplicationDetails ? (
                            /* Application Details */
                            <div className="flex flex-col gap-4">
                                {/* Social Links */}
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1"
                                        onClick={async () => {
                                            const email = selectedApplicationDetails?.email;
                                            if (email) {
                                                try {
                                                    await navigator.clipboard.writeText(selectedApplicationDetails.email);
                                                    toast.info("Email copied to clipboard.");
                                                }
                                                catch (err) {
                                                    toast.error("Failed to copy email");
                                                }
                                                
                                            }
                                        }}
                                        disabled={!selectedApplicationDetails?.email}
                                    >
                                        Copy Email
                                        <MailIcon className="ml-1 h-3 w-3" />
                                    </Button>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1"
                                        onClick={() => selectedApplicationDetails?.profile?.linkedinUrl && window.open(selectedApplicationDetails.profile.linkedinUrl, '_blank')}
                                        disabled={!selectedApplicationDetails?.profile?.linkedinUrl}
                                    >
                                        LinkedIn
                                        <ExternalLinkIcon className="ml-1 h-3 w-3" />
                                    </Button>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1"
                                        onClick={() => selectedApplicationDetails?.profile?.githubUrl && window.open(selectedApplicationDetails.profile.githubUrl, '_blank')}
                                        disabled={!selectedApplicationDetails?.profile?.githubUrl}
                                    >
                                        GitHub
                                        <ExternalLinkIcon className="ml-1 h-3 w-3" />
                                    </Button>
                                </div>

                                {/* App Dev History */}
                                {selectedApplicationDetails?.appDevInternalPk && (
                                    <Alert className="bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/20 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400">
                                        <AlertTriangleIcon />
                                        <AlertTitle>App Dev History</AlertTitle>
                                        <AlertDescription>
                                            <span>
                                                {selectedApplicationDetails?.name.split(" ")[0]} is already in App Dev. To view more about their team history and their internal profile, please <NavLink to={`/org/people/${selectedApplicationDetails?.appDevInternalPk}`} className="font-medium hover:underline underline-offset-4">click here</NavLink>.
                                            </span>
                                        </AlertDescription>
                                    </Alert>
                                )}

                                {/* Subteam Preferences */}
                                <div>
                                    <h4 className="text-md text-muted-foreground mb-2">Roles in Order of Preference</h4>
                                    <div className="flex flex-col gap-2">
                                        {selectedApplicationDetails?.rolePreferences?.map((pref, idx) => {
                                            return (
                                                <div key={idx} className="bg-muted/50 p-2 rounded border border-border">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">#{idx + 1}</span>
                                                        <span className="text-xs font-medium text-foreground">{pref.role}</span>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Notes and Feedback */}
                                <div>
                                    <h4 className="text-md text-muted-foreground mb-2">Application Notes</h4>
                                    <div className="bg-muted/50 p-3 rounded">
                                        <div className="flex items-start">
                                            <p className="text-sm font-medium mb-1 flex-grow-1">Interview and Intial Feedback</p>
                                            <Button aria-label="Add feedback" onClick={() => {
                                                setFeedbackDraft({ applicationId: selectedApplicationDetails.id, name: selectedApplicationDetails.name, text: "" });
                                            }} variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-foreground">
                                                <MessageSquarePlusIcon className="scale-x-[-1]" />
                                            </Button>
                                        </div>
                                        <div className="text-sm text-muted-foreground">
                                            <ReactMarkdown
                                                remarkPlugins={[remarkGfm]}
                                                components={{
                                                    ul: ({ node, ...props }) => <ul className="list-disc pl-4 mb-2" {...props} />,
                                                    ol: ({ node, ...props }) => <ol className="list-decimal pl-4 mb-2" {...props} />,
                                                    h6: ({ node, ...props }) => <h6 className="font-semibold mt-2" {...props} />,
                                                    p: ({ node, ...props }) => <p className="mb-2 last:mb-0 leading-relaxed" {...props} />,
                                                    hr: ({ node, ...props }) => <hr className="my-3 border-border" {...props} />
                                                }}
                                            >
                                                {selectedApplicationDetails?.notes || "No feedback entered"}
                                            </ReactMarkdown>
                                        </div>
                                    </div>
                                </div>

                                {/* Instagram Follow */}
                                <div>
                                    <h4 className="text-md text-muted-foreground mb-2">Basic Information</h4>
                                    {selectedApplicationDetails?.profile?.instagramFollow && (
                                        <div className="bg-muted/50 p-3 rounded">
                                            <p className="text-sm font-medium mb-1">Do you follow App Dev on Instagram?</p>
                                            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{selectedApplicationDetails.profile.instagramFollow}</p>
                                        </div>
                                    )}
                                </div>

                                {/* Why AppDev */}
                                {selectedApplicationDetails?.profile?.whyAppDev && (
                                    <div className="bg-muted/50 p-3 rounded">
                                        <p className="text-sm font-medium mb-1">Why are you interested in joining App Dev?</p>
                                        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{selectedApplicationDetails.profile.whyAppDev}</p>
                                    </div>
                                )}

                                {/* Additional Info */}
                                {selectedApplicationDetails?.profile?.additionalInfo && (
                                    <div>
                                        <div className="bg-muted/50 p-3 rounded">
                                            <p className="text-sm font-medium mb-1">Is there something else you'd like to tell us?</p>
                                            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{selectedApplicationDetails.profile.additionalInfo}</p>
                                        </div>
                                    </div>
                                )}

                                {/* Role Specific Responses */}
                                {selectedApplicationDetails?.responses && Object.keys(selectedApplicationDetails.responses).length > 0 && (
                                    <div>
                                        <h4 className="text-md text-muted-foreground mb-4">Role Specific Responses</h4>
                                        <div className="space-y-3">
                                            {Object.entries(selectedApplicationDetails.responses).map(([question, answer]) => (
                                                <div key={question} className="bg-muted/50 p-3 rounded">
                                                    <p className="text-sm font-medium mb-1">{question}</p>
                                                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">{answer as string}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Application Stage History */}
                                <div>
                                    <h4 className="text-md text-muted-foreground mb-4">Stage History</h4>
                                    <Timeline size="sm">
                                        {selectedApplicationDetails?.stageHistory?.slice().map((history, index) => (
                                            <TimelineItem
                                                key={index}
                                                date={new Date(history.changedAt).toLocaleString()}
                                                title={history.stage}
                                                icon={getTimelineStageIcon(history.stage)}
                                                iconColor={STAGE_STYLES[history.stage]}
                                                description={`Changed by ${history.changedBy || 'System'}`}
                                            />
                                        ))}
                                    </Timeline>
                                </div>
                            </div> /* End of Details */
                        ) : (
                            <div className="p-4 text-center text-muted-foreground">
                                <p role="alert">{review.details.error?.message ?? "Application unavailable."}</p>
                                <Button variant="outline" onClick={() => review.details.refetch()}>Retry details</Button>
                            </div>
                        )}

                    </div>

                    {/* Right Content: Application Details */}
                    <div className="flex-1 p-6 overflow-y-auto">
                        <div className="h-full flex flex-col gap-6 pt-2">
                            {/* Stage Movement Controls */}
                            <p className="text-lg text-muted-foreground leading-0">Move to Stage</p>
                            <div className="flex flex-wrap -space-x-px">
                                {stages.map((stage) => (
                                    <Button
                                        key={stage.id}
                                        variant={selectedApplication?.stage === stage.id ? "ghost" : "outline"}
                                        size="sm"
                                        className={cn(
                                            "rounded-none first:rounded-l-md last:rounded-r-md transition-all",
                                            selectedApplication?.stage === stage.id ?
                                                "bg-primary/10 text-primary border border-primary z-10 disabled:opacity-100 font-medium" :
                                                "text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-100"
                                        )}
                                        onClick={() => selectedApplication && initiateStageUpdate(selectedApplication.id, selectedApplication.stage, stage.id)}
                                        disabled={isStageSubmitting || review.details.isError || !selectedApplication || selectedApplication.stage === stage.id || !validateTransition(selectedApplication.stage, stage.id)}
                                    >
                                        {stage.name}
                                    </Button>
                                ))}
                            </div>


                            {/* Other applications load independently of the resume. */}
                            <p className="text-lg text-muted-foreground">Other Applications</p>
                            {review.details.isError ? null : review.history.isPending ? (
                                <p role="status">Loading other applications…</p>
                            ) : review.history.isError ? (
                                <div role="alert">
                                    <p>{review.history.error.message}</p>
                                    <Button variant="outline" onClick={() => review.history.refetch()}>Retry other applications</Button>
                                </div>
                            ) : (
                                <div className="flex gap-2 max-w-full overflow-x-auto">
                                    {review.history.data.map(app => (
                                        <div key={app.id} className={`flex gap-6 p-3 rounded-md border text-sm w-[200px] shrink-0 ${app.id === selectedId ? 'bg-primary/10 border-primary' : 'bg-background hover:bg-muted/50'}`}>
                                            <div className="flex flex-col leading-[1] min-w-0 flex-1">
                                                <p className="font-medium truncate">{app.teamName || 'Unknown Team'}</p>
                                                <p className="text-[10px] text-muted-foreground mt-1">Applied {new Date(app.appliedAt).toLocaleDateString()}</p>
                                            </div>
                                            <Badge className={STAGE_STYLES[app.stage]} variant="secondary">{app.stage}</Badge>
                                        </div>
                                    ))}
                                    {review.history.data.length === 0 && <p className="text-sm text-muted-foreground italic">No other applications found.</p>}
                                </div>
                            )}

                            <div className="flex items-center justify-between gap-2">
                                <p className="text-lg text-muted-foreground">Resume</p>
                                {!review.details.isError && !review.resume.isError && resumeUrl && (
                                    <Button variant="outline" size="sm" asChild>
                                        <a href={resumeUrl} target="_blank" rel="noopener noreferrer">Open resume <ExternalLinkIcon /></a>
                                    </Button>
                                )}
                            </div>
                            {review.details.isError ? null : review.resume.isError ? (
                                <div role="alert" className="min-h-80 flex-grow border rounded-md p-6">
                                    <p>{review.resume.error.message}</p>
                                    <Button variant="outline" onClick={() => review.resume.refetch()}>Retry resume</Button>
                                </div>
                            ) : review.resume.isPending || !resumeUrl ? (
                                <div role="status" className="min-h-80 flex-grow border rounded-md p-6">Loading resume…</div>
                            ) : (
                                <iframe key={selectedApplication?.applicantId} src={resumeUrl}
                                    className="w-full min-h-80 flex-grow border rounded-md" title="Resume" />
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* --- Stage Action Dialogs --- */}
            {/* 1. Reject Dialog */}
            <Dialog open={actionDialog === 'reject'} onOpenChange={(open) => !open && cancelStageUpdate()}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Confirm Rejection</DialogTitle>
                        <DialogDescription>
                            Rejecting an applicant sends a formal email to them. If you're sure they don't meet App Dev expectations or if they can't be accomodated in your team, confirm this action.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={cancelStageUpdate}>Cancel</Button>
                        <Button disabled={isStageSubmitting} variant="destructive" onClick={() => pendingTransition && executeStageUpdate(pendingTransition.applicationId, pendingTransition.newStage)}>
                            Reject {applications.find(a => a.id === pendingTransition?.applicationId)?.name.split(" ")[0]}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 2. Interview Dialog */}
            <Dialog open={actionDialog === 'interview'} onOpenChange={(open) => !open && cancelStageUpdate()}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Schedule an Interview</DialogTitle>
                        <DialogDescription>
                            Yay! We're happy that {applications.find(a => a.id === pendingTransition?.applicationId)?.name.split(" ")[0]} meets our initial expectations. Please provide a Google Calendar link for your availability and we'll email them.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4 space-y-4">
                        <Input
                            placeholder="https://calendar.google.com/..."
                            value={interviewLink}
                            onChange={(e) => setInterviewLink(e.target.value)}
                        />
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="save-link"
                                checked={saveInteviewLink}
                                onCheckedChange={(c) => setSaveInterviewLink(!!c)}
                            />
                            <Label htmlFor="save-link">Use the same link for future invites?</Label>
                        </div>

                        <div className="space-y-2">
                            <Label>Interview Guidelines</Label>
                            <Textarea
                                placeholder="Please provide specific guidelines for the interview..."
                                value={interviewGuidelines}
                                onChange={(e) => setInterviewGuidelines(e.target.value)}
                                className="min-h-[100px]"
                            />
                            <div className="flex justify-between items-center text-xs text-muted-foreground">
                                <span>Min 50, Max 500 characters</span>
                                <span className={cn(
                                    (interviewGuidelines.length < 50 || interviewGuidelines.length > 500) ? "text-destructive" : "text-green-600"
                                )}>
                                    {interviewGuidelines.length} characters
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="save-guidelines"
                                checked={saveInterviewGuidelines}
                                onCheckedChange={(c) => setSaveInterviewGuidelines(!!c)}
                            />
                            <Label htmlFor="save-guidelines">Save guidelines for future invites?</Label>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={cancelStageUpdate}>Cancel</Button>
                        <Button
                            disabled={isStageSubmitting || !interviewLink || interviewGuidelines.length < 50 || interviewGuidelines.length > 500}
                            onClick={() => pendingTransition && executeStageUpdate(pendingTransition.applicationId, pendingTransition.newStage, { interviewLink, interviewGuidelines })}
                        >
                            Invite {applications.find(a => a.id === pendingTransition?.applicationId)?.name.split(" ")[0]}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 3. Potential Hire Dialog */}
            <Dialog open={actionDialog === 'potential'} onOpenChange={(open) => !open && cancelStageUpdate()}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Move to Potential Hire?</DialogTitle>
                        <DialogDescription>
                            We'll send {applications.find(a => a.id === pendingTransition?.applicationId)?.name.split(" ")[0]} an email to inform they've passed the interview and are on hold considering space availability.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={cancelStageUpdate}>Cancel</Button>
                        <Button disabled={isStageSubmitting} onClick={() => pendingTransition && executeStageUpdate(pendingTransition.applicationId, pendingTransition.newStage)}>
                            Move {applications.find(a => a.id === pendingTransition?.applicationId)?.name.split(" ")[0]}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 4. Hired Dialog */}
            <Dialog open={actionDialog === 'hired'} onOpenChange={(open) => !open && cancelStageUpdate()}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Confirm {applications.find(a => a.id === pendingTransition?.applicationId)?.name.split(" ")[0]}'s Position</DialogTitle>
                        <DialogDescription>
                            We're excited that {applications.find(a => a.id === pendingTransition?.applicationId)?.name.split(" ")[0]} meets App Dev's talent bar. We'll send them a unique onboarding link to officially join the team.
                        </DialogDescription>
                    </DialogHeader>
                    <div>
                        <Label className="mb-3">Please choose the role that you'd like to recruit them for:</Label>
                        <Select value={hiredRole} onValueChange={setHiredRole}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="Select Role" />
                            </SelectTrigger>
                            <SelectContent>
                                {applications.find(a => a.id === pendingTransition?.applicationId)?.rolePreferences?.map(pref => (
                                    <SelectItem key={pref.role} value={pref.role}>{pref.role}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={cancelStageUpdate}>Cancel</Button>
                        <Button disabled={isStageSubmitting || !hiredRole} onClick={() => {
                            if (!pendingTransition) return;
                            const app = applications.find(a => a.id === pendingTransition?.applicationId);
                            const targetPref = app?.rolePreferences.find(p => p.role === hiredRole);
                            const targetSubteamPk = targetPref?.subteamPk || "";

                            executeStageUpdate(
                                pendingTransition.applicationId,
                                pendingTransition.newStage,
                                { hiredRole, hiredSubteamPk: targetSubteamPk }
                            );
                        }}>
                            Onboard {applications.find(a => a.id === pendingTransition?.applicationId)?.name.split(" ")[0]}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 5. Feedback Dialog */}
            <Dialog open={feedbackDialogOpen} onOpenChange={(open) => !open && setFeedbackDraft(null)}>
                <DialogContent className="min-w-xl">
                    <DialogHeader>
                        <DialogTitle>Add Feedback for {feedbackDraft?.name.split(" ")[0]}</DialogTitle>
                        <DialogDescription>
                            You're feedback means a lot towards helping make informed hiring decisions. Please keep your response concise and informative.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="mt-1">
                        <Editor
                            key={selectedApplication?.id}
                            onChange={(markdown) => {
                                setFeedbackDraft(current => current ? { ...current, text: markdown } : current);
                            }}
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setFeedbackDraft(null)}>Cancel</Button>
                        <Button onClick={handleFeedbackSubmit} disabled={isFeedbackSubmitting || !feedbackDraft?.text.trim()}>
                            {isFeedbackSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {isFeedbackSubmitting ? "Submitting..." : "Submit Feedback"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div >
    )
}
