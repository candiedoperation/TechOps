# Three-chart profile layout and project inventory QA

Source visual truth: `/var/folders/ll/b5xp2_894ml48vw4462xhv3h0000gn/T/codex-clipboard-19a50be8-0635-4e9b-9524-1dee88fcd149.png`

Latest table-header reference: `/var/folders/ll/b5xp2_894ml48vw4462xhv3h0000gn/T/codex-clipboard-cf539d7e-5466-4c4b-a0e1-241862ca4bce.png`

Latest chart-layout reference: `/var/folders/ll/b5xp2_894ml48vw4462xhv3h0000gn/T/codex-clipboard-0400fbd9-d7dd-4d56-b3ba-f3810356973e.png`

Previous QA source: `/var/folders/ll/b5xp2_894ml48vw4462xhv3h0000gn/T/codex-clipboard-fa79eaf9-9748-43e8-afcd-7797d44b277f.png`

Previous alignment reference: `/var/folders/ll/b5xp2_894ml48vw4462xhv3h0000gn/T/codex-clipboard-38dea7ab-ce02-424f-b8a0-d5581ba937a1.png`
Previous y-axis reference: `/var/folders/ll/b5xp2_894ml48vw4462xhv3h0000gn/T/codex-clipboard-9c383a96-9b14-45f4-b5af-b6d20c22348f.png`
Previous visual cleanup reference: `/var/folders/ll/b5xp2_894ml48vw4462xhv3h0000gn/T/codex-clipboard-3473f929-79f5-49f3-bbce-a00364ba0a08.png`

## Comparison setup

- Source: 1547 × 170 px reference strip with roomy metric cards, baseline comparisons, and filled trend lines.
- Implementation: 1280 × 720 px browser capture on the Member Portal project profile.
- State: Live project snapshot loaded from the App Dev Club API.
- Responsive behavior: Three metric cards use one intentional desktop row, switch to a 2-plus-1 layout at intermediate widths, and collapse to a single-column narrow layout; timestamp labels stay in the chart body and empty-state charts use fluid width.

## Findings

No actionable P0, P1, or P2 findings.

- Layout: The three available metric charts now occupy one intentional desktop row with no unused fourth slot; four-metric responses retain a balanced 2-by-2 grid for projects that return contributor data.
- Detail: Each chart renders the full eight-point series, visible weekly timestamps, point markers, horizontal guide lines, and baseline comparison when supplied by the API.
- Scale: Each metric chart now has five y-axis ticks derived from the same auto-scaled domain as its plot, including the metric unit and baseline in the domain calculation.
- Table alignment: Insights metric headers are right-aligned to the same padded cell edge as their values and baseline text; the Project column remains left-aligned.
- Project spacing: Project avatar, name, team, and status now render as one centered identity block, with tighter row padding so the project stack shares the metric rows’ vertical rhythm.
- Interaction: SVG point hit areas retain hover tooltips such as `Aug 10: 6d`; no chart values are inferred or fabricated.
- Data fidelity: Timestamp labels derive from the project snapshot week metadata, while values and baselines remain API-backed.
- Accessibility: Charts retain semantic `img` labels, and the timestamp axis is exposed as a labeled region.
- Browser health: Console errors were absent in the final project-profile pass.
- Visual cleanup: Removed the mini signal-strip decoration from the project header, overview queue, and project inventory; removed the now-empty inventory Trace column.

## Verification

- [x] `node --check app.js`
- [x] `git diff --check`
- [x] `PHI_ENVIRONMENT=local PHI_DEV_AUTH=true .venv/bin/pytest -q` — 32 passed
- [x] Desktop chart layout inspected in the in-app browser
- [x] Three metric charts occupy the full desktop row without an empty fourth slot
- [x] Eight timestamp labels verified on each rendered metric chart
- [x] Empty-state chart width made responsive
- [x] Mini signal strips absent from Overview, Projects, and project profile
- [x] Project inventory has no empty Trace column
- [x] Five y-axis labels render for each populated metric chart
- [x] Timestamp note remains horizontal after adding the y-axis gutter
- [x] Insights headers and metric values share the same right edge
- [x] Project identity blocks are vertically centered and consistently spaced

## Overview card interaction

- Each overview stat card is a keyboard-accessible button with a visible focus state.
- Active projects navigates to the Projects table with the six non-paused projects.
- Need attention navigates to the five evidence-backed Watch/At risk projects, preserving names, teams, repos, statuses, signals, freshness, and coverage.
- Clear navigates to the single Clear project; Insufficient data preserves the table empty state when the count is zero.
- Browser interaction pass completed in the in-app browser with no console errors.
- Project inventory column labels now have balanced vertical padding and a compact line-height, so the header text is centered between the panel header and the first data row without changing column alignment.
- Chart placement pass completed in the in-app browser: three chart tiles render with equal widths, consistent gutters, and no empty chart panel.

final result: passed
