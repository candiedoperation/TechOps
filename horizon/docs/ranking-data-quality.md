# Ranking data quality and analytical export

The pipeline assembles evidence for the existing `leadership-weighted-35-35-30-v1`
rubric. These changes do not rank members, calculate new scores, or change the
35% technical execution / 35% technical leadership / 30% club contribution rubric.

## Identity attribution

Canonical Gitea ownership requires an exact, typed login or full email address
that resolves uniquely and without conflicting ownership. Names, rendered author
labels, shared email domains, and heuristic candidate lists cannot establish
ownership. Legacy contributor groups require typed author proof for every commit
SHA. A group without sufficient proof remains pending.

Candidate records map to active People Portal members through the candidate's
Gitea roster login and that roster member's exact email. The union of all candidate
targets must identify one roster member. Filtering to active members cannot turn
an ambiguous identity into a match. Broad candidate lists are quarantined, and
pending identities never contribute to canonical member metrics or pull references.

## Evidence and availability

The hybrid export contains one claim per metric, with its definition, numeric
value or null, availability, attribution status, and source references. A complete
observed zero remains zero. Failed, partial, unavailable, unknown, unlinked, and
not-applicable fields remain distinct. Incomplete observations are retained only
as explicitly labelled subtotals. Collection gaps apply to their affected scopes
and metric families.

Authored merged PRs count PRs opened by that account and marked merged.
Merged PRs contributed to count merged PRs containing commits by that identity;
they do not imply authorship, review, approval, or merge responsibility. Branch-only
commits are those observed exclusively outside the default branch. Missing branch
reachability metadata cannot establish branch-only status. Full metric definitions
are in both export manifests.

Applicant answers, application ratings, interviewer notes, resume claims, and club
roles have separate evidence types. An explicitly null detailed rating cannot fall
back to a list card's default zero. Resume extraction retains all extracted pages
and evidence paragraphs, with an available text-extraction fallback and explicit
failure/empty status. Source pointers are checked before the export is written.

## Artifacts

Under `data/horizon/latest/llm-ranking-export/`:

- `members.jsonl`: active member cards and canonical versus pending metric fields.
- `evidence.jsonl`: claim-level evidence and source pointers.
- `gitea-pulls.jsonl`: pull evidence with proven canonical relationships.
- `identity-review.jsonl`: pending identities assigned for human review.
- `pending-pull-identities.jsonl`: unresolved pull relationships, stored once.
- `unassigned-identities.jsonl`: ambiguous or otherwise unassigned identity records.
- `coverage.json`: shared collection scope, gaps, warnings, and definitions.
- `source-registry.json` and `manifest.json`: source and artifact hashes.

Detailed identity aliases remain in audit files. Member cards reference stable
candidate identity IDs, and oversized candidate lists are suppressed in pending
pull records with pointers back to the original raw evidence.

## Versioned JSON and JSONL ranking evidence

The export under `data/horizon/latest/llm-ranking-export/` is the only ranking
artifact family. `members.jsonl` contains one bounded member card per record;
claim-level and identity evidence remain in their dedicated JSONL files, while
`coverage.json`, `source-registry.json`, and `manifest.json` describe scope,
availability, and hashes. JSONL preserves structured evidence without a
spreadsheet-oriented scalar conversion step.

When one pending identity exists, its scalar metrics remain separate from canonical
metrics. When several exist, candidate totals are blank with
`multiple_identities_not_aggregated` status. `candidate_max_identity` columns report
the maximum complete metric from a single pending identity; different columns may
come from different identities. These maxima are neither totals nor confirmed
member activity. Full per-identity detail remains in the JSONL audit files.

Ranks and scores are copied only from a result matching the current export
manifest hash and rubric. The JSON/JSONL exporter verifies all registered artifact
and input hashes. A stale result is preserved while its scores, ranks, and prior
exclusions are withheld until a fresh ranking pass. All output remains provisional
for human review. The exporter never runs an LLM or recalculates scores.

## Human evidence screening and live recruiting

These exports retain reviewable source text; they are not automatically safe model
inputs. Manifests mark them as awaiting human evidence screening. Structured
protected attributes and prestige fields are omitted from model member cards, but
free text can still contain sensitive information. Review and redact the text
before any model use. The live API requires the upstream
`evidence_reviewed_for_scoring=true` assertion before using unstructured text.
Application answers are kept separate from interviewer observations.

The live deterministic recruiting rubric uses 55% contribution and 45% reviewed
ability, with missing dimensions omitted and remaining weights renormalized.
Its version and exact source snapshot are saved with each run. The separate
35/35/30 external ranking result is not automatically imported into that rubric.
Neither path makes employment decisions. All employer-policy matches require
human review and never automatically exclude a person from the queue.

## Rebuild without ranking

For historical/manual artifact maintenance, from the project root using the
selected People Portal snapshot (these commands rewrite the selected output):

```sh
.venv/bin/python build_member_profiles.py --peopleportal-zip data/horizon/horizon-peopleportal-2026-09-08T052900Z-yashwant-resume-update.zip
.venv/bin/python scripts/build_llm_ranking_export.py
```

For new collections, prefer `run_pipeline.py --peopleportal-zip PATH`, which
builds these artifacts in a new immutable run and publishes them together.
Rebuild profiles first whenever the underlying source changes. The historical
ranking result remains an audit artifact until a separately authorized fresh LLM
ranking pass replaces it.

## Implementation and validation

Shared identity and missingness rules live in `backend/gitea_evidence.py`.
`scripts/member_analytics.py` retains typed collector proofs and collection states;
`backend/member_analytics.py` and `backend/models.py` preserve them on ingestion.
`build_member_profiles.py` assembles profiles and recruiting evidence.
`scripts/build_llm_ranking_export.py` writes the claim registry, JSONL evidence,
coverage, and manifest files.

Regressions are in `tests/test_member_analytics_collector.py`,
`tests/test_member_analytics.py`, `tests/test_member_profiles_builder.py`,
`tests/test_llm_ranking_export.py`, and `tests/test_profile_evidence_hardening.py`.
The real-snapshot checks and final hashes are recorded in
`data/horizon/latest/ranking-data-quality-audit.json`.
