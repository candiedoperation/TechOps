# Track 4 on staging

Runs the whole ranking graph (`ranking_run` through `publish_ranking`, with its
asset checks) against a throwaway Postgres on the staging box, using a synthetic
FALL 2026 semester. The input tables owned by unmerged tracks (T1.1, T2.5, T2.6,
T3.4, T5.x) come from `inputs.sql`, a copy of their deployed definitions, so
this tests Track 4 against the production table shapes.

From your Mac, in the TechOps clone (the branch does not need to be pushed):

```
git show t4/7c-staging-runner:horizon/dev/t4-staging/ship-to-staging.sh > /tmp/ship-t4.sh
bash /tmp/ship-t4.sh                                   # seed, run, check
bash /tmp/ship-t4.sh t4/7c-staging-runner -- --tests --ui
bash /tmp/ship-t4.sh t4/7c-staging-runner -- --down
```

`ship-to-staging.sh` copies the branch's committed `horizon/` folder to
`/opt/horizon-t4/<branch>` on the box over one `ssh appdev-staging`
connection, runs `run-on-staging.sh` there and copies the compare report back.
On the box itself:

```
bash dev/t4-staging/run-on-staging.sh [--tests] [--ui]
bash dev/t4-staging/run-on-staging.sh --down
```

The run ends with "All expected results hold." and exit code 0, or lists what
came out wrong and exits 1. It checks:

- the seeded cases: who is ranked and how, `group_too_small`,
  `insufficient_data`, `no_sow`, the excluded review bucket, explanations;
- metric values: `seed.py` works out files owned, surviving commits, active
  weeks, the longest inactive stretch, PRs reviewed, review turnaround,
  collaborative PRs, delivery and every survey rating from the seeded rows with
  the card formulas, and the run must match each one exactly.

Run on the code from before the T4.2/T4.3 fixes, the value checks fail on
collaborative PRs (Co-authored-by trailers), engineer and tech lead ratings
(respondent roles), the longest inactive stretch (the gap since the last
activity) and review turnaround (the daylight-saving hour).

- Creates only `horizon-t4-*` containers, a `horizon-t4` network and a
  `horizon-t4-venv` volume. Postgres publishes no port; the Dagster UI (`--ui`)
  binds 127.0.0.1:3070. Nothing in the Coolify stack is touched.
- Every run starts from an empty database. The password is generated into
  `.pg-password` (git-ignored) and removed by `--down`.
- Explanations use deterministic fallbacks unless `ANTHROPIC_API_KEY` is set
  in the shell. Staging rules: do not use a real key there.
- A v1 run is scored next to the published v2 run (v1 has the survey buckets),
  and the admin compare report is written to `out/`.

Locally, without Docker: create a database, then
`HORIZON_DATABASE_URL=... python dev/t4-staging/seed.py && python dev/t4-staging/run_t4.py --compare-v1`.
