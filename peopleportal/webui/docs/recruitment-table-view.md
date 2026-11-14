# Design Doc: Recruitment Tracker — Table View

**Status:** Draft, awaiting approval — no code written yet.
**Page:** `/org/teams/:teamId/recruitment` → `DashboardTeamRecruitment` (`src/components/fabric/DashboardTeamRecuitment.tsx`)
**Reference:** converting the current Kanban board (screenshot 1) into a searchable, sortable table (screenshot 2's pattern)

---

## 1. Problem

The current "Applications" tab is a drag-and-drop Kanban board, one column per stage. That works when there are a handful of candidates, but it doesn't scale:

- No way to search/filter — finding one candidate among dozens means scanning every column.
- No sorting (by date, name, rating).
- Columns get vertically long and the board gets wide; nothing is visible at a glance across the whole pipeline.
- Cross-team application history is buried inside a per-candidate detail modal — you have to open every card one at a time to see it.

Screenshot 2 (a generic job-tracker table) is the target shape: one row per record, fixed columns, a search bar, badge-styled tags for categorical fields.

## 2. Scope

**Replaces** the Kanban board as the primary view in the "Applications" tab. The other two tabs on this page (**Statistics**, **Recruitment Settings**) are untouched.

**Out of scope for this doc** (flagged as open questions below, not decided yet):
- Whether drag-and-drop/Kanban should remain available as a secondary view toggle.
- Bulk actions (multi-select + bulk reject, etc.) — the table layout makes this easy to add later, but it's not requested yet.
- Pagination — addressed below as a recommendation, not a requirement.

## 3. Column spec

| Column | Source | Notes |
|---|---|---|
| **Name** | `GET /api/ats/applications/{teamId}` → `name` | unchanged from today's card |
| **Email** | **new** — see §5, backend change needed | not currently returned by the list endpoint |
| **Role** | `rolePreferences[0].role` (+ a "+N more" affordance if they ranked multiple) | unchanged data, new column |
| **Status** | `stage` | colored badge, see §4 — also the control used to change stage |
| **Applied** | `appliedAt` | formatted date, sortable |
| **Rating** | `stars` | existing 0–5 star field, unchanged |
| **Other Applications** | `GET .../{applicantId}/otherapps` (lazy, on click) | dropdown/popover, see §6 |

Clicking anywhere else on the row (not Status, not the Other Applications control) opens the **existing** detail dialog — full profile, resume iframe, responses, notes/stars editor, stage-history timeline. That dialog is not changing; this doc is only about the row-list that launches it.

## 4. Status column — colored badges

The color system already exists in this file and is **reused as-is**, not invented:

```12:97:peopleportal/webui/src/components/fabric/DashboardTeamRecuitment.tsx
    const STAGE_STYLES: { [key: string]: string } = {
        'Applied': 'text-blue-700 bg-blue-50 border-blue-200',
        'Interview': 'text-purple-700 bg-purple-50 border-purple-200',
        'Hired': 'text-green-700 bg-green-50 border-green-200',
        'Rejected': 'text-red-700 bg-red-50 border-red-200',
        'Potential Hire': 'text-orange-700 bg-orange-50 border-orange-200',
    }
```

Today this only decorates the stage-history timeline and the "other applications" list inside the detail modal. This design promotes it to the primary Status cell in every row, as a `Badge`, exactly like screenshot 2's "Work Model" column (Hybrid / On Site / Remote pills).

**Important behavioral difference from screenshot 2:** "Work Model" in the reference image is a static label. Status here is not static — it's how recruiters currently *drive* the pipeline (today, by dragging a card to a new column). Losing drag-and-drop means the Status badge needs to become the interaction point:

- Clicking the badge opens a small menu listing only the stages that are valid from the current one (reusing the exact `VALID_TRANSITIONS` ruleset already enforced server-side in `ATSController.updateApplicationStage` — Applied → Interview/Rejected, Interview → Potential Hire/Hired/Rejected, Potential Hire → Hired/Rejected, Hired/Rejected → nothing).
- Picking **Interview** or **Hired** opens the same modal/fields that exist today (interview link + guidelines; hired role + subteam) — that logic isn't changing, just its entry point moves from "drop on a column" to "pick from this menu."
- Picking **Rejected** or **Potential Hire** fires the transition directly, same as today.

## 5. Backend change required: add `email` to the list endpoint

The list endpoint doesn't currently return email at all:

```625:652:peopleportal/server/src/controllers/ATSController.ts
    async getTeamApplications(@Path() teamId: string): Promise<ATSKanbanApplicationCard[]> {
        try {
            const applications = await Application.find({
                teamPk: teamId
            })
                .select('applicantId stage rolePreferences appliedAt stars')
                .populate<{ applicantId: IApplicant }>('applicantId', 'fullName')
                .lean()
                .exec();

            const kanbanData: ATSKanbanApplicationCard[] = applications.map((app) => ({
                id: app._id.toString(),
                applicantId: app.applicantId._id.toString(),
                name: app.applicantId.fullName || 'Unknown Applicant',
                stage: app.stage,
                rolePreferences: app.rolePreferences,
                appliedAt: app.appliedAt,
                stars: app.stars || 0
            }));
```

This needs one small, low-risk addition: populate `email` alongside `fullName`, and add it to the returned shape (`ATSKanbanApplicationCard` type gets a new `email: string` field). Everything else needed for this table already exists:

- "Other Applications" dropdown → `GET /api/ats/applications/{teamId}/{applicantId}/otherapps` **already returns exactly what's needed** (resolved team friendly names, resolved subteam names, stage, appliedAt, hiredRole) — this endpoint is already called from the existing detail modal, just reused here at the row level. No backend change.
- Search by email → pure client-side filter once email is on each row. No backend change beyond the one above.

## 6. "Other Applications" control

Per-row icon button (e.g. a small "history" or "layers" icon next to the name) opens a popover showing the applicant's other applications, styled identically to the existing list in the detail modal:

```1026:1031:peopleportal/webui/src/components/fabric/DashboardTeamRecuitment.tsx
                                        <Badge className={`${STAGE_STYLES[app.stage]} capitalize`} variant="secondary">{app.stage}</Badge>
                                    </div>
                                ))}
                                {otherApplications.length === 0 && <p className="text-sm text-muted-foreground italic">No other applications found.</p>}
```

Fetched **lazily on open** (not pre-fetched for every row up front) — same pattern already used for the detail modal, avoids N extra requests firing just from rendering the table.

## 7. Search bar

Single input above the table, filtering by **email** (as requested). Recommendation: also match against **name**, since that's the first thing most recruiters will actually type — flagging this as a suggestion, not assuming it. Purely client-side against the already-loaded row set; no backend change, no debounce needed at this scale.

## 8. Wireframe (structure, not pixels)

```
[ Search by email...                                    ] [Status: All ▾]

┌────────────────────┬───────────────────────┬──────────────┬──────────┬──────────┬────────┬─────┐
│ Name                │ Email                 │ Role         │ Status   │ Applied  │ Rating │ ⋯   │
├────────────────────┼───────────────────────┼──────────────┼──────────┼──────────┼────────┼─────┤
│ Katherine Johnson   │ seed-applicant-4-...  │ Frontend Eng │ Applied  │ Oct 22   │ ☆☆☆☆☆  │ 🕐  │
│ Grace Hopper        │ seed-applicant-2-...  │ Frontend Eng │ Interview│ Oct 22   │ ☆☆☆☆☆  │ 🕐  │
│ Alan Turing         │ seed-applicant-3-...  │ Backend Eng  │ Rejected │ Oct 22   │ ☆☆☆☆☆  │ 🕐  │
│ Ada Lovelace        │ seed-applicant-1-...  │ Backend Eng  │ Pot.Hire │ Oct 22   │ ★☆☆☆☆  │ 🕐  │
└────────────────────┴───────────────────────┴──────────────┴──────────┴──────────┴────────┴─────┘
```

`🕐` = the "Other Applications" popover trigger. `Status` badges use the existing `STAGE_STYLES` colors (blue/purple/red/orange/green).

## 9. Open questions (need your decision before implementation)

1. **Does Kanban go away entirely, or become a secondary view toggle** (e.g. a "Board / Table" switch at the top of the Applications tab)? This doc assumes full replacement per your request, but drag-and-drop is arguably faster for one-off single moves — worth confirming you're OK trading that away.
2. **Status column interaction** — menu-on-click as described in §4, or would you rather it be a plain `<select>` dropdown? Menu-on-click can show *why* a transition is blocked (e.g. grey out Hired until Interview happened); a native select can't show that as naturally.
3. **Search scope** — email only (as asked), or also name (recommended)?
4. **Row density at scale** — you currently have ~20 seeded candidates; if this team realistically grows past 100+, do you want client-side pagination (like screenshot 2's "5724 records" footer) or infinite scroll? Not needed yet, flagging so it's a conscious choice rather than something that becomes a problem later.
5. **Sort defaults** — newest-applied-first (current Kanban's implicit order) or alphabetical by name?

---

Once you sign off on this (and the open questions above), implementation is: one backend one-liner (§5), and a new table component replacing the `KanbanProvider` block in `DashboardTeamRecuitment.tsx`, reusing the existing detail dialog, stage-transition logic, and `otherapps` fetch as-is.
