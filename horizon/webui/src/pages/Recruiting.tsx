/**
 * Members -- the recruiting reviewer workspace.
 *
 * This is an evidence-first review queue, not an automated hiring decision.
 * The ordering is provisional until a human confirms, adjusts or defers each
 * candidate, every candidate exposes the source evidence behind their score,
 * and the review controls are the only thing that changes a candidate's state.
 *
 * Eligibility is kept separate from ability throughout: they are different
 * judgements and are recorded as different fields.
 */

import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleCheckIcon, SparklesIcon } from "lucide-react"

import { errorMessage, requestJson } from "@/api/client"
import { finiteNumber } from "@/api/normalize"
import {
  analyticsMembersQuery,
  queryKeys,
  recruitingAuditQuery,
  recruitingCandidateQuery,
  recruitingOverviewQuery,
} from "@/api/queries"
import type {
  AnalyticsMember,
  EligibilityStatus,
  RecruitingCandidate,
  RecruitingAudit,
  RecruitingCandidateDetail,
  ReviewStatus,
} from "@/api/types"
import { Eyebrow, MetricValue, Mono, NoData, PageHeading } from "@/components/horizon/primitives"
import { EmptyPanel, EmptyTableRow, ErrorPanel, LoadingPanel, TableSkeletonRows } from "@/components/horizon/states"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { formatCount, formatDate } from "@/lib/format"
import { toast } from "sonner"

import { cn } from "@/lib/utils"

const REVIEW_STATUS_META: Record<ReviewStatus, { label: string; className: string }> = {
  pending: { label: "Pending human review", className: "bg-status-watch-surface text-status-watch" },
  confirmed: { label: "Confirmed", className: "bg-status-clear-surface text-status-clear" },
  adjusted: { label: "Rank adjusted", className: "bg-status-data-surface text-status-data" },
  deferred: { label: "Deferred", className: "bg-status-pause-surface text-status-pause" },
}

const ELIGIBILITY_META: Record<EligibilityStatus, { label: string; className: string }> = {
  eligible: { label: "Outreach eligible", className: "bg-status-clear-surface text-status-clear" },
  excluded: { label: "Outreach excluded", className: "bg-status-risk-surface text-status-risk" },
  needs_review: { label: "Eligibility needs review", className: "bg-status-watch-surface text-status-watch" },
}

function ReviewStatusBadge({ status }: { status: ReviewStatus | undefined }) {
  const meta = REVIEW_STATUS_META[status ?? "pending"] ?? REVIEW_STATUS_META.pending
  return (
    <Badge variant="outline" className={meta.className}>
      {meta.label}
    </Badge>
  )
}

function EligibilityBadge({ status }: { status: EligibilityStatus | null | undefined }) {
  const meta = ELIGIBILITY_META[status ?? "needs_review"] ?? ELIGIBILITY_META.needs_review
  return (
    <Badge variant="outline" className={meta.className}>
      {meta.label}
    </Badge>
  )
}

/**
 * Why this candidate's contribution score rests on the data it does.
 *
 * A rank built on zero measured commits is not the same claim as a rank built
 * on measured low output, and the score alone cannot tell them apart. The
 * commit-author identity behind a roster account is frequently a *different*
 * identity -- a personal email never registered on the Gitea account -- and
 * that work is counted under an unmatched row instead, leaving the roster row
 * at zero. Surfacing that here keeps a reviewer from reading an attribution
 * gap as a performance signal.
 */
function SourceStatusBadge({
  candidate,
  stats,
}: {
  candidate: RecruitingCandidate
  stats: AnalyticsMember | undefined
}) {
  if (stats && (stats.commits ?? 0) === 0) {
    return (
      <Badge variant="destructive" title="No Gitea commits are attributed to this roster account. If this member commits from an unregistered email address, their work is counted under a separate unmatched identity and is not in this score.">
        No attributed activity
      </Badge>
    )
  }
  if (candidate.source_status === "missing") {
    return (
      <Badge variant="secondary" title="No People Portal evidence was available for this candidate, so the ability, resume and interview components were never scored.">
        No portal evidence
      </Badge>
    )
  }
  return <span className="text-muted-foreground text-sm">{candidate.source_status ?? "—"}</span>
}

function ScoreBar({ label, value, barClass }: { label: string; value: number | null | undefined; barClass: string }) {
  const number = finiteNumber(value)
  const width = number === null ? 0 : Math.max(0, Math.min(100, number))
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <strong className="tabular-nums">{number === null ? <NoData /> : `${Math.round(number)}/100`}</strong>
      </div>
      <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
        <span className={cn("block h-full rounded-full", barClass)} style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}

export function Recruiting() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selected = searchParams.get("candidate")
  const queryClient = useQueryClient()

  const overview = useQuery(recruitingOverviewQuery())
  const runId = overview.data?.run?.run_id ?? null

  const audit = useQuery({ ...recruitingAuditQuery(runId ?? ""), enabled: Boolean(runId) })
  const detail = useQuery({
    ...recruitingCandidateQuery(selected ?? "", runId),
    enabled: Boolean(selected) && overview.isSuccess,
  })

  const runAnalysis = useMutation({
    mutationFn: async () => {
      await requestJson<unknown>("/recruiting/run", { method: "POST" })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.recruitingOverview })
      toast.success("New provisional recruiting signal generated")
    },
    onError: (error) => toast.error(errorMessage(error, "Recruiting analysis could not be generated.")),
  })

  function selectCandidate(login: string | null) {
    const params = new URLSearchParams(searchParams)
    if (login) params.set("candidate", login)
    else params.delete("candidate")
    setSearchParams(params)
  }

  const candidates = overview.data?.candidates ?? []
  const summary = overview.data?.summary

  /* The rubric's contribution component is derived from the Gitea analytics
     run, but the overview payload carries only the resulting score. Joining
     the run itself lets the table show the measured activity behind that
     score -- which is the only way a reader can tell a genuinely quiet
     candidate apart from one whose commits landed under an unmatched
     identity and were therefore never counted. */
  const memberStats = useQuery({
    ...analyticsMembersQuery({ sort: "commits", organization: "all", search: "", includeService: true, includeUnmatched: true }),
    staleTime: 5 * 60_000,
  })
  const statsByLogin = new Map<string, AnalyticsMember>(
    (memberStats.data ?? []).map((member) => [member.login, member]),
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        eyebrow="Discovery evidence · Human review required"
        title="Members"
        meta={
          overview.data?.run ? (
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <Mono>
                Run {overview.data.run.run_id} · {formatDate(overview.data.run.generated_at, true)}
              </Mono>
              <span>{overview.data.run.llm_used ? "LLM organizer" : "Deterministic"}</span>
              <span>{overview.data.run.signal_version ?? "recruiting-v2"}</span>
            </div>
          ) : undefined
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => overview.refetch()}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => runAnalysis.mutate()} disabled={runAnalysis.isPending}>
              {runAnalysis.isPending ? "Running…" : "Run analysis ↻"}
            </Button>
          </>
        }
      />

      {overview.isError ? (
        <ErrorPanel message={errorMessage(overview.error)} onRetry={() => overview.refetch()} />
      ) : null}

      {overview.isPending ? <LoadingPanel label="Loading the review queue" /> : null}

      {overview.data ? (
        <>
          {overview.data.run?.source_warnings?.length ? (
            <details className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                {overview.data.run.source_warnings.length} source warnings — part of this run is missing, not zero
              </summary>
              <ul className="mt-2 flex flex-col gap-1 pl-4">
                {overview.data.run.source_warnings.map((warning, index) => (
                  <li key={index} className="list-disc">
                    <Mono>{warning}</Mono>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="border-status-clear/30 bg-status-clear-surface text-status-clear flex items-start gap-3 rounded-lg border px-4 py-3">
            <CircleCheckIcon className="size-5 shrink-0" aria-hidden="true" />
            <div className="flex flex-col">
              <strong className="text-sm font-semibold">Evidence first</strong>
              <span className="text-sm opacity-90">
                Human review is required. Horizon makes no employment decisions.
              </span>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryTile label="Review queue" value={summary?.candidate_count ?? null} foot="Candidates" />
            <SummaryTile label="Evidence signals" value={summary?.underrated_count ?? null} foot="Signals" />
            <SummaryTile
              label="Human reviewed"
              value={`${summary?.reviewed_count ?? 0}/${summary?.candidate_count ?? 0}`}
              foot="Decisions"
            />
            <SummaryTile label="Needs review" value={summary?.pending_count ?? null} foot="Pending" />
          </div>

          <AuditPanel
            isPending={audit.isPending && Boolean(runId)}
            isError={audit.isError}
            error={audit.error}
            onRetry={() => audit.refetch()}
            data={audit.data}
          />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <Card>
              <CardHeader className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <CardTitle>Evidence review queue</CardTitle>
                  <p className="text-muted-foreground text-sm">Review the evidence before deciding.</p>
                </div>
                <Eyebrow>{candidates.length} candidates</Eyebrow>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="w-full overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Discovery order</TableHead>
                        <TableHead>Candidate</TableHead>
                        <TableHead className="text-right">Signal</TableHead>
                        <TableHead className="text-right">Club contribution</TableHead>
                        <TableHead className="text-right">Stats quality</TableHead>
                        <TableHead className="text-right">Ability</TableHead>
                        <TableHead className="text-right">Resume</TableHead>
                        <TableHead className="text-right">Interview</TableHead>
                        <TableHead className="text-right">Commits</TableHead>
                        <TableHead className="text-right">Lines owned</TableHead>
                        <TableHead className="text-right">Evidence</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Eligibility</TableHead>
                        <TableHead>Review</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {overview.isFetching && candidates.length === 0 ? (
                        <TableSkeletonRows columns={14} />
                      ) : candidates.length === 0 ? (
                        <EmptyTableRow columns={14} message="No candidates in this run." />
                      ) : (
                        candidates.map((candidate) => (
                          <TableRow
                            key={candidate.member_login}
                            tabIndex={0}
                            role="button"
                            aria-label={`Review ${candidate.member_name}`}
                            aria-pressed={candidate.member_login === selected}
                            className={cn("cursor-pointer", candidate.member_login === selected && "bg-muted/60")}
                            onClick={() => selectCandidate(candidate.member_login)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault()
                                selectCandidate(candidate.member_login)
                              }
                            }}
                          >
                            <TableCell>
                              <div className="flex flex-col">
                                <strong className="tabular-nums">
                                  #{candidate.reviewer_rank ?? candidate.provisional_rank ?? "—"}
                                </strong>
                                <span className="text-muted-foreground text-xs">
                                  Provisional {candidate.provisional_rank ?? "—"}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col">
                                <strong className="text-sm font-medium">{candidate.member_name}</strong>
                                <Mono className="text-muted-foreground">{candidate.member_login}</Mono>
                              </div>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MetricValue value={candidate.provisional_score ?? null} />
                              <span className="text-muted-foreground text-xs">/100</span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MetricValue value={candidate.contribution_score ?? null} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MetricValue value={candidate.evidence_quality_score ?? null} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MetricValue value={candidate.ability_score ?? null} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MetricValue value={candidate.resume_score ?? null} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MetricValue value={candidate.interview_score ?? null} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MetricValue
                                value={statsByLogin.get(candidate.member_login)?.commits ?? null}
                                format="count"
                              />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MetricValue
                                value={statsByLogin.get(candidate.member_login)?.blame_lines ?? null}
                                format="count"
                              />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              <MetricValue value={candidate.evidence_claim_count ?? null} format="count" />
                            </TableCell>
                            <TableCell>
                              <SourceStatusBadge candidate={candidate} stats={statsByLogin.get(candidate.member_login)} />
                            </TableCell>
                            <TableCell className="text-sm">{candidate.eligibility_status ?? "—"}</TableCell>
                            <TableCell className="text-sm">{candidate.review_status ?? "—"}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
                <div className="text-muted-foreground flex items-center justify-between text-xs">
                  <span>Provisional</span>
                  <Mono>{summary?.pending_count ?? 0} pending</Mono>
                </div>
              </CardContent>
            </Card>

            <CandidateDetail
              login={selected}
              runId={runId}
              candidateCount={summary?.candidate_count ?? 0}
              isPending={detail.isPending && Boolean(selected)}
              isError={detail.isError}
              error={detail.error}
              onRetry={() => detail.refetch()}
              detail={detail.data ?? null}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}

function SummaryTile({ label, value, foot }: { label: string; value: number | string | null; foot: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs font-medium">{label}</span>
        <span className="font-display text-3xl leading-none font-semibold tabular-nums">
          {value === null || value === undefined ? <NoData /> : value}
        </span>
        <span className="text-muted-foreground text-xs">{foot}</span>
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ audit */

function AuditPanel({
  isPending,
  isError,
  error,
  onRetry,
  data,
}: {
  isPending: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
  data: RecruitingAudit | undefined
}) {
  if (isPending) return <LoadingPanel label="Loading the evidence audit" />
  if (isError) return <ErrorPanel title="Evidence audit" message={errorMessage(error)} onRetry={onRetry} />

  const audit = data?.audit
  if (!audit) return null

  const coverage = audit.coverage ?? {}
  const calibration = audit.calibration ?? {}
  const flags = audit.flags ?? []
  const recentReviews = audit.recent_reviews ?? []
  const multiReviewer = Number(calibration.multi_reviewer_candidates ?? 0)
  const disagreements = Number(calibration.disagreement_candidates ?? 0)
  const calibrationLabel = disagreements ? "Needs calibration" : multiReviewer ? "Calibrating" : "Not started"
  const calibrationClass = disagreements
    ? "bg-status-watch-surface text-status-watch"
    : multiReviewer
      ? "bg-status-clear-surface text-status-clear"
      : "bg-status-data-surface text-status-data"

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Eyebrow>Governance</Eyebrow>
          <CardTitle>Evidence audit</CardTitle>
        </div>
        <Badge variant="outline" className={calibrationClass}>
          {calibrationLabel}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <AuditStat
            label="Coverage"
            value={`${formatCount(coverage.with_observable_stats ?? 0)}/${formatCount(coverage.candidate_count ?? 0)}`}
            foot="With stats"
          />
          <AuditStat
            label="Review completion"
            value={
              coverage.review_completion_pct === null || coverage.review_completion_pct === undefined
                ? null
                : `${Math.round(Number(coverage.review_completion_pct))}%`
            }
            foot="Reviewed"
          />
          <AuditStat
            label="Reviewers"
            value={formatCount(calibration.reviewer_count ?? 0)}
            foot={`${formatCount(calibration.review_count ?? 0)} records`}
          />
          <AuditStat
            label="Agreement sample"
            value={
              calibration.agreement_rate_pct === null || calibration.agreement_rate_pct === undefined
                ? null
                : `${Math.round(Number(calibration.agreement_rate_pct))}%`
            }
            foot={`${formatCount(multiReviewer)} with 2+ reviews`}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Review flags</h3>
            {flags.length === 0 ? (
              <p className="text-muted-foreground text-sm">No coverage or calibration flags for this run.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {flags.map((flag, index) => (
                  <li key={index} className="rounded-md border p-2 text-sm">
                    {flag}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Recent reviewer activity</h3>
            {recentReviews.length === 0 ? (
              <p className="text-muted-foreground text-sm">No reviews yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {recentReviews.slice(0, 5).map((review, index) => (
                  <li key={index} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                    <span className="flex min-w-0 flex-col">
                      <strong className="truncate font-medium">{review.member_login}</strong>
                      <span className="text-muted-foreground truncate text-xs">
                        {review.decision}
                        {review.reviewer_user_id ? ` · ${review.reviewer_user_id}` : ""}
                      </span>
                    </span>
                    <small className="text-muted-foreground shrink-0">{formatDate(review.created_at, true)}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function AuditStat({ label, value, foot }: { label: string; value: string | null; foot: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <strong className="text-base font-semibold tabular-nums">{value ?? <NoData />}</strong>
      <span className="text-muted-foreground text-xs">{foot}</span>
    </div>
  )
}

/* ----------------------------------------------------------- detail panel */

function CandidateDetail({
  login,
  runId,
  candidateCount,
  isPending,
  isError,
  error,
  onRetry,
  detail,
}: {
  login: string | null
  runId: string | null
  candidateCount: number
  isPending: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
  detail: RecruitingCandidateDetail | null
}) {
  if (!login) {
    return (
      <EmptyPanel
        title="Select a candidate"
        description="Pick a row from the queue to read the evidence behind its provisional order."
        icon={<SparklesIcon className="size-8" />}
      />
    )
  }
  if (isPending) return <LoadingPanel label="Loading candidate evidence" />
  if (isError) return <ErrorPanel message={errorMessage(error)} onRetry={onRetry} />
  if (!detail) {
    return <EmptyPanel title="No evidence for this candidate" icon={<SparklesIcon className="size-8" />} />
  }

  return <CandidateDetailBody detail={detail} runId={runId} candidateCount={candidateCount} />
}

function CandidateDetailBody({
  detail,
  runId,
  candidateCount,
}: {
  detail: RecruitingCandidateDetail
  runId: string | null
  candidateCount: number
}) {
  const queryClient = useQueryClient()
  const eligibility = detail.eligibility ?? {}
  const human = detail.human_review ?? {}
  const stats = detail.member_stats ?? {}
  const interview = detail.interview ?? {}
  const resume = detail.resume ?? {}
  const context = detail.context_excluded_from_score ?? {}
  const sharedRanking = detail.ranking ?? null
  const refs = detail.evidence_refs ?? []

  const [decision, setDecision] = useState(human.decision ?? "")
  const [eligibilityDecision, setEligibilityDecision] = useState(eligibility.status ?? "")
  const [finalRank, setFinalRank] = useState(String(human.final_rank ?? detail.provisional_rank ?? ""))
  const [note, setNote] = useState(human.note ?? "")

  const hasPeoplePortalEvidence = Boolean(
    detail.source_status === "complete" ||
      resume.summary ||
      (resume.evidence ?? []).length ||
      interview.summary ||
      (interview.evidence ?? []).length,
  )

  const save = useMutation({
    mutationFn: async () => {
      if (!runId) throw new Error("This run is no longer current; refresh the queue before reviewing.")
      /* Fail closed on a mismatched run: a review must attach to the run whose
         evidence the reviewer actually read. */
      if (detail.run_id !== runId) {
        throw new Error("The candidate's evidence belongs to an older run; refresh before reviewing.")
      }
      const payload = {
        run_id: runId,
        member_login: detail.member_login,
        decision,
        eligibility_decision: eligibilityDecision || null,
        final_rank:
          decision === "adjust"
            ? Number(finalRank)
            : decision === "confirm"
              ? (detail.provisional_rank ?? null)
              : null,
        note: note.trim(),
      }
      await requestJson<unknown>("/recruiting/reviews", { method: "POST", body: payload })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.recruitingOverview })
      await queryClient.invalidateQueries({
        queryKey: queryKeys.recruitingCandidate(detail.member_login, runId),
      })
      toast.success("Human review recorded")
    },
    onError: (error) => toast.error(errorMessage(error, "Human review could not be recorded.")),
  })

  function handleSave() {
    if (!decision) {
      toast.error("Choose a human review decision first.")
      return
    }
    const rank = Number(finalRank)
    if (decision === "adjust" && (!finalRank || !Number.isInteger(rank) || rank < 1 || rank > candidateCount)) {
      toast.error("Enter a final rank between 1 and the number of candidates when adjusting the signal.")
      return
    }
    if ((decision === "adjust" || decision === "defer" || eligibilityDecision) && !note.trim()) {
      toast.error("Add a note for ordering or eligibility decisions.")
      return
    }
    save.mutate()
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Eyebrow>Candidate</Eyebrow>
          <CardTitle>{detail.member_name}</CardTitle>
          <Mono className="text-muted-foreground">
            {detail.member_login} · Discovery order {detail.provisional_rank ?? "—"}
          </Mono>
        </div>
        <div className="flex flex-wrap gap-2">
          <ReviewStatusBadge status={detail.review_status} />
          <EligibilityBadge status={eligibility.status} />
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start gap-4 rounded-lg border p-4">
          <div className="flex flex-col">
            <Eyebrow>Signal</Eyebrow>
            <strong className="font-display text-3xl leading-none font-semibold tabular-nums">
              <MetricValue value={detail.provisional_score ?? null} />
              <small className="text-muted-foreground text-sm font-normal">/100</small>
            </strong>
          </div>
          {detail.rationale ? <p className="min-w-0 flex-1 text-sm">{detail.rationale}</p> : null}
        </div>

        <div className="flex flex-col gap-3">
          {sharedRanking ? (
            <>
              <ScoreBar
                label="Technical execution"
                value={
                  sharedRanking.technical_execution_score === null ||
                  sharedRanking.technical_execution_score === undefined
                    ? null
                    : Number(sharedRanking.technical_execution_score) * 20
                }
                barClass="bg-status-clear"
              />
              <ScoreBar
                label="Technical leadership"
                value={
                  sharedRanking.technical_leadership_score === null ||
                  sharedRanking.technical_leadership_score === undefined
                    ? null
                    : Number(sharedRanking.technical_leadership_score) * 20
                }
                barClass="bg-status-data"
              />
              <ScoreBar
                label="Club contribution"
                value={
                  sharedRanking.club_contribution_score === null ||
                  sharedRanking.club_contribution_score === undefined
                    ? null
                    : Number(sharedRanking.club_contribution_score) * 20
                }
                barClass="bg-chart-3"
              />
            </>
          ) : (
            <>
              <ScoreBar label="Club contribution" value={detail.contribution_score} barClass="bg-chart-3" />
              <ScoreBar label="Reviewed ability evidence" value={detail.ability_score} barClass="bg-status-clear" />
              {hasPeoplePortalEvidence ? (
                <>
                  <ScoreBar label="Resume evidence" value={detail.resume_score} barClass="bg-status-clear" />
                  <ScoreBar label="Interview evidence" value={detail.interview_score} barClass="bg-status-data" />
                </>
              ) : null}
            </>
          )}
          <ScoreBar label="Evidence quality" value={detail.evidence_quality_score} barClass="bg-status-watch" />
        </div>

        {sharedRanking ? (
          <div className="flex flex-col gap-1 rounded-lg border p-3">
            <Eyebrow>Shared ranking artifact</Eyebrow>
            <p className="text-sm">
              {`${sharedRanking.rubric_version} · ${sharedRanking.ranking_status} · exact combined rank ${sharedRanking.combined_rank ?? "unranked"}`}
            </p>
            <p className="text-muted-foreground text-sm">
              People Portal and Gitea evidence were joined upstream; this screen displays the imported pipeline
              scores.
            </p>
          </div>
        ) : null}

        <ClaimsBlock claims={detail.evidence_claims} />
        <ReviewFlagsBlock detail={detail} />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">Gitea</Badge>
              <h3 className="text-sm font-medium">Contribution</h3>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="Commits" value={stats.commits} />
              <StatTile label="Merged PR contributions" value={stats.pulls_merged_contributed_to} />
              <StatTile label="Authored PRs merged" value={stats.pulls_merged} />
              <StatTile label="Reviews" value={stats.reviews_submitted} />
              <StatTile label="Active days" value={stats.active_days} />
              <StatTile label="Issues" value={stats.issues_opened} />
              <StatTile
                label="Repositories"
                value={Array.isArray(stats.repositories) ? stats.repositories.length : null}
              />
            </div>
          </div>

          {hasPeoplePortalEvidence ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">People Portal</Badge>
                  <h3 className="text-sm font-medium">Interview</h3>
                  <strong className="ml-auto tabular-nums">
                    {interview.score === null || interview.score === undefined ? <NoData /> : `${interview.score}/5`}
                  </strong>
                </div>
                <p className="text-sm">{interview.summary || "No summary."}</p>
                <EvidenceBullets items={interview.evidence} empty="No evidence." />
              </div>
              <div className="flex flex-col gap-2 rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">People Portal</Badge>
                  <h3 className="text-sm font-medium">Resume</h3>
                </div>
                <p className="text-sm">{resume.summary || "No summary."}</p>
                <EvidenceBullets items={resume.evidence} empty="No evidence." />
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground flex flex-col gap-2 rounded-lg border border-dashed p-4">
              <div className="flex items-center gap-2">
                <Badge variant="outline">Optional</Badge>
                <h3 className="text-sm font-medium">People Portal</h3>
              </div>
              <p className="text-sm">
                No People Portal evidence was ingested for this run. Nothing is inferred in its place.
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4 rounded-lg border p-4">
          <div className="flex flex-col gap-1">
            <Eyebrow>Human review</Eyebrow>
            <h3 className="text-base font-medium">Review evidence</h3>
            <p className="text-muted-foreground text-sm">
              Eligibility is separate from ability. Select eligible only after checking the employment evidence and
              outreach fit.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recruiting-decision">Decision</Label>
              <Select value={decision} onValueChange={setDecision}>
                <SelectTrigger id="recruiting-decision">
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="confirm">Confirm evidence order</SelectItem>
                  <SelectItem value="adjust">Adjust</SelectItem>
                  <SelectItem value="defer">Defer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recruiting-eligibility">Eligibility</Label>
              <Select value={eligibilityDecision} onValueChange={(value) => setEligibilityDecision(value as EligibilityStatus)}>
                <SelectTrigger id="recruiting-eligibility">
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="eligible">Eligible</SelectItem>
                  <SelectItem value="needs_review">Needs review</SelectItem>
                  <SelectItem value="excluded">Excluded</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recruiting-final-rank">Reviewed discovery order</Label>
              <Input
                id="recruiting-final-rank"
                type="number"
                min={1}
                value={finalRank}
                onChange={(event) => setFinalRank(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recruiting-review-note">Reviewer note</Label>
            <Textarea
              id="recruiting-review-note"
              rows={3}
              placeholder="Note required for adjust/defer"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <Button onClick={handleSave} disabled={!decision || save.isPending} className="w-fit">
            {save.isPending ? "Saving…" : "Save →"}
          </Button>
        </div>

        <ReviewHistoryBlock history={detail.review_history} />

        <div className="flex flex-col gap-1 rounded-lg border p-3">
          <Eyebrow>Context · not scored</Eyebrow>
          <p className="text-sm">
            {(context.prior_employers ?? []).length ? (context.prior_employers ?? []).join(", ") : "None"}
          </p>
          <p className="text-muted-foreground text-sm">
            {context.note || "Employer and school prestige are excluded from scoring."}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Eyebrow>References</Eyebrow>
          {refs.length === 0 ? (
            <p className="text-muted-foreground text-sm">None</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {refs.map((reference, index) => (
                <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{reference.label ?? reference.source_type}</span>
                  <Mono className="text-muted-foreground">
                    {reference.source_id} · {reference.source_field}
                  </Mono>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function StatTile({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border p-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <strong className="text-sm font-semibold tabular-nums">
        <MetricValue value={finiteNumber(value)} format="count" />
      </strong>
    </div>
  )
}

function EvidenceBullets({ items, empty }: { items: string[] | undefined; empty: string }) {
  const list = items ?? []
  if (!list.length) return <p className="text-muted-foreground text-sm">{empty}</p>
  return (
    <ul className="flex flex-col gap-1 pl-4">
      {list.map((item, index) => (
        <li key={index} className="list-disc text-sm">
          {item}
        </li>
      ))}
    </ul>
  )
}

function ClaimsBlock({ claims }: { claims: RecruitingCandidateDetail["evidence_claims"] }) {
  const list = claims ?? []
  if (!list.length) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Source claims</h3>
      <ul className="flex flex-col gap-2">
        {list.map((claim, index) => (
          <li key={index} className="flex flex-col gap-1 rounded-md border p-2.5">
            <strong className="text-sm font-medium">{claim.claim}</strong>
            <span className="text-muted-foreground text-sm">{claim.supporting_text}</span>
            <Mono className="text-muted-foreground">{claim.source_field}</Mono>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ReviewFlagsBlock({ detail }: { detail: RecruitingCandidateDetail }) {
  const groups: string[] = [
    ...(detail.contradictions ?? []).map((item) => `Contradictions: ${item}`),
    ...(detail.duplicate_flags ?? []).map((item) => `Duplicate flags: ${item}`),
    ...(detail.review_flags ?? []).map((item) => `Review flags: ${item}`),
    ...(detail.caveats ?? []).map((item) => `Evidence caveats: ${item}`),
  ]
  if (!groups.length) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Review flags</h3>
      <ul className="flex flex-col gap-1.5">
        {groups.map((item, index) => (
          <li key={index} className="rounded-md border p-2 text-sm">
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ReviewHistoryBlock({ history }: { history: RecruitingCandidateDetail["review_history"] }) {
  const list = history ?? []
  if (!list.length) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Review history</h3>
      <ul className="flex flex-col gap-2">
        {list.map((review, index) => (
          <li key={index} className="flex flex-col gap-1 rounded-md border p-2.5">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm font-medium">{review.decision}</strong>
              <span className="text-muted-foreground text-xs">{review.reviewer_user_id || "reviewer"}</span>
            </span>
            <small className="text-muted-foreground">{formatDate(review.created_at, true)}</small>
            {review.note ? <p className="text-sm">{review.note}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
