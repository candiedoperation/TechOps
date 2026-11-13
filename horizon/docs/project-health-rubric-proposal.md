# Project health rubric: proposal (T5.1)

**Status:** proposal for Yash to approve. No scoring code is written until it is approved.
**Version name if approved:** `health-v1` (any later change gets a new version).

## The idea in one paragraph

Every weekly project run already produces raw numbers: SOW task status (T5.4), engineering flow and review metrics (T5.5, T5.6), ownership metrics (T5.7) and risk flags (T5.8). This proposal turns them into one status per project: **on track**, **at risk** or **off track**. Each of four parts gets a status from its own metrics. The worst metric in a part decides that part's status, so no problem is hidden. The four parts are then combined with weights into the overall status. Missing data is never treated as bad: a metric or part without data is skipped and the remaining weights are scaled up.

The status describes the project **right now**: Flow and Review use the latest one or two complete weeks, and Delivery uses every task due so far. The full week-by-week history stays visible on the project page, because T5.5 stores every week since the semester started.

## Summary

| Part | Weight | Metrics (table) | Status rule |
|---|---|---|---|
| Delivery against SOW | 40 | overdue share, completion of due tasks (`horizon_projects.sow_task_status`, `sow_tasks`) | worst metric wins |
| Engineering flow | 25 | open PRs per engineer, open PR age, merges (`horizon_projects.project_metrics`) | worst metric wins |
| Ownership and capacity | 20 | top owner share, active engineer share (`horizon_projects.project_metrics`) | worst metric wins |
| Review quality | 15 | PRs merged without review, distinct reviewers (`horizon_projects.project_metrics`) | worst metric wins |
| Risk | 0 | flags in `horizon_projects.project_risk_flags` | shown as alerts, not scored |

Points per part: on track = 100, at risk = 50, off track = 0.
Overall score = weighted average of the parts that have data (weights rescaled to the parts present).

| Overall score | Overall status |
|---|---|
| 75 or more | On track |
| 50 to under 75 | At risk |
| under 50 | Off track |
| parts with data weigh less than 50 | Not enough data |

### Why these weights

The parts are ranked by how directly they answer "will this project deliver what it promised?":

- **Delivery 40 (the largest).** It is the only part that measures the outcome itself: the SOW is the team's commitment for the semester, and tracking progress against it is one of Horizon's two goals. It stays under half because its evidence depends on Claude matching PRs to tasks, which can be wrong. Under half also means Delivery alone can't make a project off track: Delivery off track with everything else on track scores 60 (at risk).
- **Flow 25.** It is the early warning for Delivery: PRs piling up or waiting for days usually turn into missed SOW tasks a few weeks later. It comes from exact Gitea timestamps, so it's reliable, and it changes week to week.
- **Ownership 20.** It describes a structural risk: if one person owns most of the code or few people are active, an exam week or someone leaving can stall the project. It changes slowly and affects delivery less directly than Flow, so it ranks below it.
- **Review quality 15 (the smallest).** Skipped reviews let mistakes in, but on their own they rarely sink a student project. It only measures the review process, not real code quality. Part of it already shows up in Flow, because slow reviews make PRs older.
- **Risk 0.** Its flags repeat what the other parts score (see section 5), so they are shown as alerts instead.

What the weights do in practice:

- One part at risk on its own never changes an on-track project's overall status (the lowest result is 80, when Delivery is at risk).
- One part off track on its own never makes a project off track (the lowest result is 60, when Delivery is off track).
- Problems in Delivery and Flow together, the two parts closest to the outcome, make a project off track (Delivery off and Flow at risk = 47.5).

How the exact numbers were chosen. Weights are whole multiples of 5, because finer steps would suggest more precision than the evidence has. Then four rules narrow them down:

1. **No single part decides alone.** One part off track scores 100 − w, and one part at risk scores 100 − w/2. Keeping those at 50 or more and 75 or more needs every weight to be 50 or less.
2. **Mostly exact data.** Delivery is the only part built on Claude's PR matching. At 40, the other 60 points come from exact Gitea data. 45 would also pass rule 1, but 40 keeps a clear majority on exact data.
3. **Delivery plus Flow trouble means off track.** Delivery off track (0 points) with Flow at risk scores 100 − 40 − F/2. For that to fall under 50, Flow needs more than 20, so Flow = 25.
4. **The ranking holds.** That leaves 100 − 40 − 25 = 35 for Ownership and Review, with Flow above Ownership and Ownership above Review. In multiples of 5, the only split that does that is Ownership = 20 and Review = 15 (25/10 would tie Ownership with Flow).

These are starting weights. After 3 to 4 weeks of real runs, compare the statuses with what project leads and exec see, and adjust in a new version.

Below, "the last 2 weeks" means the last two complete weeks (`week_start` Mondays, America/New_York), never the partial current week. "Today" is `local_date(as_of)`.

## 1. Delivery against the SOW (weight 40)

**Question:** is the team doing what its SOW promised, on time?

**Source:** `horizon_projects.sow_task_status` (`completion`, `completion_value`, `timeline_status`, `evidence_state`) joined to `horizon_projects.sow_tasks` (`due_date`), for the run's tasks, after overrides from `horizon_projects.sow_task_overrides` (as in T5.4).

**Due tasks** D = tasks with `due_date` on or before today.

**Fairness rule: "needs lead check".** A task is marked not done whenever no PR matched it, even if the team did the work and named the PR badly. So an overdue task with `evidence_state = 'none'` is **not counted as overdue**. It is labelled **needs lead check**, so the project lead can confirm it or fix it with an override (T6.7). Only overdue tasks with some evidence (`supported` or `uncertain`) count against the team.

| Metric | Formula | On track | At risk | Off track |
|---|---|---|---|---|
| Overdue share | overdue tasks with evidence / \|D\| | 10% or less | more than 10%, up to 25% | more than 25%, or 3 or more such tasks |
| Completion of due tasks | Σ `completion_value` over D / \|D\| (same as T4.4 `team_verified_completion`) | 0.8 or more | 0.5 to under 0.8 | under 0.5 |

**Guard against an inactive team:** if more than half of the due tasks need a lead check, Delivery shows **needs lead check** instead of on track (it scores as at risk). Otherwise a team that did nothing would have no evidence, nothing counted as overdue, and look healthy. Flow's merge check also catches this.

**Missing:** no SOW, or no tasks due yet: Delivery is skipped. The `no_sow` alert (T5.8) still appears 21 days into the semester.

The overdue-share off-track line is the same as T5.8's `overdue_tasks` critical rule, so the two stay consistent.

## 2. Engineering flow (weight 25)

**Question:** is work moving, or piling up?

**Source:** `horizon_projects.project_metrics` (T5.5) and `team_size_engineering` (T5.7).

| Metric | Formula | On track | At risk | Off track |
|---|---|---|---|---|
| Open PRs per engineer | `open_prs_end_of_week` / `team_size_engineering`, latest complete week | 2 or less | more than 2, up to 4 | more than 4 |
| Open PR age | `median_open_pr_age_days`, latest complete week | under 4 days | 4 to 7 days (7 included) | more than 7 days |
| Merges | `prs_merged` summed over the last 2 weeks | 2 or more | 1 | 0 |

**Why these metrics:** open PRs per engineer shows whether work is piling up, and age shows whether it is stuck. On their own, both look perfect for a team that stopped working (no open PRs), so the merge count is there to catch that.

**Why per engineer:** 6 open PRs is a lot for 2 engineers (3 each) but fine for 8 (under 1 each). About 1 to 2 unfinished items per person is a common work-in-progress limit.

**Why 4 and 7 days:** in open source, 80% of merged PRs are merged within 3.7 days (Gousios et al., ICSE 2014), so a PR still waiting after 4 days is already slower than most. LinearB's 2026 benchmarks (8.1M PRs, about 4,800 teams) rate a cycle time over 161 hours (about 6.7 days) as the worst tier for mostly full-time teams. A PR waiting more than a week has also missed a whole weekly meeting. Both studies measure time to merge, not the age of open PRs, and neither looks at student clubs, so these are starting values to recalibrate after a few weeks of real data.

**Missing:** `team_size_engineering` = 0: open PRs per engineer is skipped. No open PRs: age is NULL (`no_open_prs`) and skipped. The first 2 weeks of the semester: merges are skipped as too early to judge.

## 3. Ownership and capacity (weight 20)

**Question:** does the project depend on one person, and is the team actually contributing?

**Source:** `horizon_projects.project_metrics` (T5.7).

| Metric | Formula | On track | At risk | Off track |
|---|---|---|---|---|
| Top owner share | `top_owner_share` (only when `team_size_engineering` is 3 or more) | 50% or less | more than 50%, up to 70% | more than 70% |
| Active engineer share | `active_contributors` / `team_size_engineering` (activity in the 14 days before as_of) | 60% or more | 40% to under 60% | under 40% |

**Small teams:** with 1 or 2 engineers, one person will often own more than half the code even when the work is split fairly, so top owner share is skipped. This matches T5.8's `single_owner` flag, which also needs at least 3 engineers.

**Roles:** tech leads usually write more code. The 50% line leaves room for a tech lead to own half of the code. Judging individual people by role is Track 4's job; this part only asks whether the project is at risk.

**Missing:** `unresolved_identity_share` above 0.2 (the numbers are unreliable), or no eligible lines yet: Ownership is skipped.

## 4. Review quality (weight 15)

**Question:** is code checked by someone else before it goes in?

**Source:** `horizon_projects.project_metrics` (T5.6).

| Metric | Formula | On track | At risk | Off track |
|---|---|---|---|---|
| Merged without review | PRs merged in the last 2 weeks with no counting review before merge / PRs merged in the last 2 weeks (from `merged_prs_without_review_share` and `prs_merged`) | 10% or less | more than 10%, up to 30% | more than 30% |
| Distinct reviewers | `distinct_reviewers`, latest complete week | 2 or more | 1 | 0, only when PRs were merged that week |

`changes_requested_share` is shown on the page but not judged: a high value can mean careful reviewers or weak first drafts, and Horizon can't tell which.

**Missing:** no merges in the last 2 weeks: merged-without-review is skipped (Flow already reports it). 0 reviewers in a week with no merges is a quiet week, not a problem, so it's skipped.

## 5. Risk (weight 0: shown as alerts)

The T5.8 flags (`horizon_projects.project_risk_flags`) are shown next to the status as alerts, but they are not scored. Most of them repeat problems another part already scores: `overdue_tasks` (Delivery), `no_recent_merges` (Flow), `single_owner` (Ownership). Scoring them again would punish the same problem twice. Two flags add something no other part has, so they must stay visible: `no_sow` (Delivery is skipped when there is no SOW) and `review_bottleneck` (a two-week trend).

## Worked examples (5 engineers, Sunday 2026-11-08)

### Example A: StudyBuddy

| Part | Inputs | Metric statuses | Part status |
|---|---|---|---|
| Flow | 6 open PRs; median age 4.6 days; merges 3 + 2 = 5 | 1.2 per engineer on track; age at risk; merges on track | At risk |
| Review | 5 merged in 2 weeks, 1 without review; 3 reviewers | 20% at risk; reviewers on track | At risk |
| Delivery | 8 due: 5 done, 1 partial, 2 overdue (1 with uncertain evidence, 1 with none) | overdue 1/8 = 12.5% at risk; completion 5.5/8 = 0.69 at risk; 1 needs lead check | At risk |
| Ownership | top owner 45%; 4 of 5 active; 3% unresolved | on track; 80% on track | On track |

Overall = (40×50 + 25×50 + 15×50 + 20×100) / 100 = **60, at risk**. The page shows Flow, Review and Delivery as the reasons, plus one task for the lead to check.

### Example B: CampusEats (week 4, no SOW uploaded)

| Part | Inputs | Metric statuses | Part status |
|---|---|---|---|
| Delivery | no SOW | skipped | Skipped (alert: `no_sow`) |
| Flow | 11 open PRs; median age 9 days; 1 merge in 2 weeks | 2.2 per engineer at risk; age off track; merges at risk | Off track |
| Review | 8 merged, 2 without review; 2 reviewers | 25% at risk; reviewers on track | At risk |
| Ownership | top owner 40%; 3 of 5 active | on track; 60% on track | On track |

Weights with data = 25 + 15 + 20 = 60, which is at least 50, so there is enough data.
Overall = (25×0 + 15×50 + 20×100) / 60 = 2750 / 60 = **45.8, off track**, with a `no_sow` alert.

## Not included yet

- **Testing:** a testing part would be valuable, but Horizon has no CI results, and the T1.1 PR tables don't store which files a PR changed. It could be added later from Gitea Actions results, or by ingesting each PR's changed files.
- **Build, deploy and incident data:** Horizon has no source for these.

## Decisions for Yash

1. **Weights** 40 / 25 / 20 / 15, with Risk at 0 and shown as alerts.
2. **"Needs lead check":** overdue tasks with no PR evidence are not counted as overdue. This changes how T5.8 risk-v1 counts `overdue_tasks` today.
3. **Unmatched PR list:** show leads the merged PRs that matched no SOW task, so they can link them to a task or mark them unrelated. Today T6.7 overrides only change a task's status and owners, so this would extend T6.4/T6.7.
4. **First 2 weeks:** merges are skipped as too early to judge. Is that the right grace period?
5. **Thresholds** are starting values. Recalibrate after 3 to 4 weeks of real runs.

## Sources

- Gousios, Pinzger and van Deursen, ["An Exploratory Study of the Pull-based Software Development Model"](https://pure.tudelft.nl/ws/portalfiles/portal/7416754/TUD_SERG_2014_005.pdf), ICSE 2014.
- LinearB, [2026 Software Engineering Benchmarks Report](https://assets.linearb.io/image/upload/v1765300694/resources/LinearB_2026_Software_Engineering_Benchmarks_Report.pdf).
