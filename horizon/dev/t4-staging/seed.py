"""Seed a throwaway Horizon database with a synthetic FALL 2026 semester for Track 4.

    HORIZON_DATABASE_URL=postgresql://... python dev/t4-staging/seed.py

Creates the schema (pipeline/schema.sql, then inputs.sql with the deployed
definitions of the other tracks' tables) and fills the input tables. All data
is invented and deterministic. It covers:

- Atlas: 5 engineers, a normal project, with Co-authored-by trailers (one names
  a teammate, one a bot) and a project lead who rates the tech lead.
- Beacon: 4 engineers with engineers_review_prs off, so review_collaboration is
  excluded and its weight split over the other buckets.
- Comet: 1 engineer, so group_too_small.
- Dune: 3 engineers, no SOW (delivery NULL, reason no_sow), and one engineer
  with no Git activity at all.
- 4 tech leads ranked club-wide; a PM, project leads and an archived project
  that are not ranked.
- Two survey rounds with answers from tech leads, engineers and project leads,
  including answers T4.3 must not count.
- An engineer who stops contributing in September (Gus Reyes), and review
  requests answered across the 1 November daylight-saving change, with the
  database session in New York time (as psycopg then returns New York
  datetimes, which once cost an hour).

It also writes public.t4_expected: values for some metrics worked out here from
the seeded rows with the card formulas, independently of the pipeline, so the
run can be checked number by number.
"""

from __future__ import annotations

import math
import os
import random
import uuid
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from statistics import fmean, median
from zoneinfo import ZoneInfo

import psycopg
import psycopg.sql
from psycopg.types.json import Jsonb

HERE = Path(__file__).parent
SCHEMA = HERE.parents[1] / "pipeline" / "schema.sql"
NY = ZoneInfo("America/New_York")
SEASON = ("FALL", 2026)
WINDOW = (date(2026, 8, 31), date(2026, 12, 11))
AS_OF = datetime(2026, 11, 15, 23, 59, tzinfo=NY)
W_START = datetime.combine(WINDOW[0], time.min, NY)
PROJECT_RUN = "staging-project-run-1"
ORG = "appdev-staging"
NOW = AS_OF - timedelta(hours=1)
COUNTING = {"APPROVED", "REQUEST_CHANGES", "COMMENT"}

PROJECTS = {
    "p-atlas": ("Atlas", ["atlas-api", "atlas-web"], ["Ada Park", "Ben Ortiz", "Cara Liu", "Dev Shah", "Eli Moss"]),
    "p-beacon": ("Beacon", ["beacon"], ["Fay Kim", "Gus Reyes", "Hana Ito", "Ivan Cole"]),
    "p-comet": ("Comet", ["comet"], ["Jade Wu"]),
    "p-dune": ("Dune", ["dune"], ["Kai Lee", "Lena Fox", "Milo Grant"]),
}
TECH_LEADS = {"p-atlas": "Nora Diaz", "p-beacon": "Omar Haddad", "p-comet": "Pia Novak", "p-dune": "Quinn Ash"}
PROJECT_LEADS = {"p-atlas": "Sam Ruiz", "p-beacon": "Tia Bell"}
NO_GIT = {"Milo Grant"}
# Stops contributing after this date, so the gap since the last activity is the
# longest one (T4.2: the trailing gap counts).
STOPPED = {"Gus Reyes": date(2026, 9, 27)}
NO_SOW = {"p-dune"}


def pk(name: str) -> str:
    return "stg-" + name.lower().replace(" ", "-")


def email(name: str) -> str:
    return pk(name)[4:] + "@appdev.test"


def at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime.combine(day, time(hour, minute), NY)


def weeks_until(end: date):
    day = WINDOW[0]
    while day <= end:
        yield day
        day += timedelta(days=7)


class Seed:
    def __init__(self, connection: psycopg.Connection):
        self.connection, self.counts = connection, defaultdict(int)

    def add(self, table: str, **row):
        columns = ", ".join(row)
        # dicts and lists of non-strings are JSONB; lists of strings are TEXT[].
        values = [Jsonb(v) if isinstance(v, dict) or (isinstance(v, list) and not (v and isinstance(v[0], str)))
                  else v for v in row.values()]
        self.connection.execute(
            f"INSERT INTO {table} ({columns}) VALUES ({', '.join(['%s'] * len(row))}) ON CONFLICT DO NOTHING", values)
        self.counts[table] += 1


def seed(connection: psycopg.Connection, rng: random.Random) -> dict:
    s = Seed(connection)
    roster_pks, by_email = set(), {}
    for project, (name, repos, engineers) in PROJECTS.items():
        s.add("horizon_gt_features.projects", project_pk=project, season_type=SEASON[0], season_year=SEASON[1],
              name=name.lower(), gitea_org=ORG, friendly_name=name, window_start=WINDOW[0], window_end=WINDOW[1],
              archived=False, retrieved_at=NOW)
        people = [(TECH_LEADS[project], ["tech_lead", "engineer"], "Tech Lead")]
        people += [(e, ["engineer"], "Software Engineer") for e in engineers]
        if project in PROJECT_LEADS:
            people.append((PROJECT_LEADS[project], ["project_lead"], "Project Lead"))
        if project == "p-atlas":
            people.append(("Rae Quist", ["pm"], "Product Manager"))
        for person, roles, title in people:
            s.add("horizon_gt_features.project_members", project_pk=project, authentik_user_pk=pk(person),
                  username=pk(person)[4:], email=email(person), display_name=person, roles=roles,
                  role_titles={roles[0]: title}, tenure_semesters=rng.randint(1, 5),
                  role_mapping_version="staging-roles-v1", retrieved_at=NOW)
            roster_pks.add(pk(person))
            by_email[email(person)] = pk(person)
        for repo in repos:
            s.add("horizon_gt_features.project_repositories", project_pk=project, organization=ORG,
                  repository=repo, default_branch="main", retrieved_at=NOW)
    s.add("horizon_gt_features.projects", project_pk="p-old", season_type=SEASON[0], season_year=SEASON[1],
          name="old", gitea_org=ORG, friendly_name="Old Project", window_start=WINDOW[0], window_end=WINDOW[1],
          archived=True, retrieved_at=NOW)
    connection.execute("INSERT INTO horizon_ranking.project_review_settings VALUES ('p-beacon', false, 'stg-exec', now())")

    expected, e_end = {}, AS_OF.date()
    activity_days = defaultdict(set)  # (member, project) -> local dates with activity
    reviews_by = defaultdict(set)     # reviewer -> PR keys with a counting review in W
    requests_to, first_review = defaultdict(list), {}  # for review_turnaround_hours
    pr_author, contributors, merged_in_w = {}, defaultdict(set), set()
    pr_number = review_id = event_id = 0
    for project, (_name, repos, engineers) in PROJECTS.items():
        team = engineers + [TECH_LEADS[project]]
        strength = {person: rng.uniform(0.25, 1.0) for person in team}
        for repo in repos:
            run_id = f"stg-run-{repo}"
            s.add("horizon_gt_features.pipeline_runs", run_id=run_id, status="complete", organization=ORG,
                  repository=repo, default_branch="main", source_commit_sha="f" * 40,
                  source_retrieved_at=AS_OF - timedelta(days=1), files_tracked=10, files_captured=10,
                  files_skipped_binary=0, files_empty=0, files_failed=0, roster_source="staging-seed",
                  roster_retrieved_at=AS_OF - timedelta(days=1), started_at=AS_OF - timedelta(days=1),
                  completed_at=AS_OF - timedelta(hours=20))
            for person in team:
                if person in NO_GIT:
                    continue
                key = (pk(person), project)
                st = strength[person] * (0.4 if person in TECH_LEADS.values() else 1.0)
                lines = int(200 + st * 3000 * rng.uniform(0.7, 1.3))
                majority = int(st * 20)
                s.add("horizon_gt_features.engineering_contribution", run_id=run_id, organization=ORG,
                      repository=repo, authentik_user_pk=pk(person), identity_resolution="directory_email",
                      identity_key=pk(person), raw_author_identities_json=[], eligible_source_lines=lines + 50,
                      non_boundary_surviving_lines=lines, log_non_boundary_surviving_lines=math.log1p(lines),
                      eligible_repository_lines=20000, non_boundary_repository_lines=18000,
                      repository_ownership_share=0.1, non_boundary_repository_share=0.1, files_owned=10,
                      majority_owned_files=majority, surviving_commits=5, eligible_repository_files=100)
                expected.setdefault(key, defaultdict(float))["files_majority_owned"] += majority
                commits = int(5 + st * 35)
                expected[key]["surviving_commits"] += commits
                for c in range(commits):
                    for f in range(rng.randint(1, 3)):
                        s.add("horizon_gt_features.blame_commit_summary", run_id=run_id, organization=ORG,
                              repository=repo, blamed_file_path=f"src/file{f}.ts",
                              commit_sha=f"{repo}-{pk(person)}-{c:03d}", author_name=person,
                              author_email=email(person), authentik_user_pk=pk(person),
                              identity_resolution="directory_email", authored_at=AS_OF - timedelta(days=30),
                              eligible=True, eligibility_reason="eligible", reaches_history_boundary=False,
                              line_count=rng.randint(3, 80))
                for week in weeks_until(STOPPED.get(person, e_end)):
                    if rng.random() > 0.35 + 0.6 * st:
                        continue
                    for c in range(rng.randint(1, 4)):
                        when = at(week + timedelta(days=rng.randint(0, 4)), rng.randint(10, 22))
                        if when > AS_OF:
                            continue
                        added = rng.randint(5, 400)
                        s.add("horizon_gt_features.git_commits", organization=ORG, repository=repo,
                              commit_sha=f"{repo}-{pk(person)}-{when:%m%d%H}-{c}", parent_shas=["0" * 40],
                              author_name=person, author_email=email(person), authentik_user_pk=pk(person),
                              identity_resolution="directory_email", authored_at=when, committer_name=person,
                              committer_email=email(person), committed_at=when, subject="Work", files_changed=2,
                              lines_added=added, lines_deleted=3, eligible_lines_added=added,
                              eligible_lines_deleted=3, on_default_branch=True, first_seen_run_id=run_id,
                              last_seen_run_id=run_id)
                        activity_days[key].add(when.astimezone(NY).date())
            # Pull requests, PR commits (some with Co-authored-by trailers), reviews and requests.
            for author in [e for e in engineers if e not in NO_GIT]:
                for _ in range(int(1 + strength[author] * 7)):
                    pr_number += 1
                    latest = (STOPPED[author] - WINDOW[0]).days if author in STOPPED else 75
                    created = at(WINDOW[0] + timedelta(days=rng.randint(3, latest)), rng.randint(9, 20))
                    merged = rng.random() < 0.85
                    merged_at = created + timedelta(hours=rng.randint(6, 96)) if merged else None
                    prk = (repo, pr_number)
                    pr_author[prk] = pk(author)
                    s.add("horizon_gt_features.gitea_pull_requests", organization=ORG, repository=repo,
                          number=pr_number, title=f"Change {pr_number}", body="", author_login=pk(author)[4:],
                          author_pk=pk(author), state="closed" if merged else "open", merged=merged,
                          created_at=created, merged_at=merged_at, closed_at=merged_at, base_branch="main",
                          head_branch=f"feature/{pr_number}", html_url=f"https://git.test/{ORG}/{repo}/pulls/{pr_number}",
                          retrieved_at=NOW)
                    if merged and W_START <= merged_at <= AS_OF:
                        merged_in_w.add(prk)
                    others = [p for p in team if p != author and p not in NO_GIT]
                    message, people_on_pr = "Work", {pk(author)}
                    if project == "p-atlas" and pr_number % 4 == 0 and others:
                        friend = rng.choice(others)
                        message = f"Work\n\nCo-authored-by: {friend} <{email(friend).upper()}>"
                        people_on_pr.add(pk(friend))
                    elif project == "p-atlas" and pr_number % 4 == 1:
                        message = "Work\n\nCo-authored-by: Claude <noreply@anthropic.com>"
                    commits = [(author, f"pr{pr_number}-a", message)]
                    if others and rng.random() < 0.3:
                        helper = rng.choice(others)
                        commits.append((helper, f"pr{pr_number}-b", "Pairing"))
                        people_on_pr.add(pk(helper))
                    for person, sha, text in commits:
                        s.add("horizon_gt_features.pr_linked_commit_messages", organization=ORG, repository=repo,
                              pull_request_number=pr_number, commit_sha=sha, author_name=person,
                              author_email=email(person), authentik_user_pk=pk(person),
                              identity_resolution="directory_email", candidate_count=1, committed_at=created,
                              message=text, dagster_run_id=run_id)
                        if created <= AS_OF:  # a PR-branch commit counts as activity (the view's pr_branch rows)
                            activity_days[(pk(person), project)].add(created.astimezone(NY).date())
                    contributors[prk] = people_on_pr & roster_pks
                    # Comet gets one fixed review request instead (below).
                    k = 0 if project == "p-comet" else min(len(others), rng.randint(0, 2))
                    for reviewer in rng.sample(others, k=k):
                        event_id += 1
                        requested = created + timedelta(hours=1)
                        s.add("horizon_gt_features.gitea_pr_review_requests", organization=ORG, repository=repo,
                              pr_number=pr_number, event_id=event_id, requested_login=pk(reviewer)[4:],
                              requested_pk=pk(reviewer), requested_at=requested, retrieved_at=NOW)
                        if requested <= AS_OF:
                            requests_to[pk(reviewer)].append((prk, requested))
                        if rng.random() < 0.3 + 0.6 * strength[reviewer]:
                            review_id += 1
                            state = rng.choice(["APPROVED", "APPROVED", "COMMENT", "REQUEST_CHANGES", "PENDING"])
                            submitted = requested + timedelta(hours=rng.uniform(1, 90) / strength[reviewer])
                            s.add("horizon_gt_features.gitea_pr_reviews", organization=ORG, repository=repo,
                                  pr_number=pr_number, review_id=review_id, reviewer_login=pk(reviewer)[4:],
                                  reviewer_pk=pk(reviewer), state=state, submitted_at=submitted, retrieved_at=NOW)
                            if state in COUNTING and W_START <= submitted <= AS_OF:
                                reviews_by[pk(reviewer)].add(prk)
                            if state in COUNTING:
                                first_review[(pk(reviewer), prk)] = submitted
        if project == "p-comet":
            # Requested Sat 31 Oct 11:00 EDT, reviewed Mon 2 Nov 11:00 EST: 49 hours
            # apart, though the wall clocks say 48.
            pr_number += 1
            jade, pia = PROJECTS[project][2][0], TECH_LEADS[project]
            created, requested, reviewed = at(date(2026, 10, 31), 10), at(date(2026, 10, 31), 11), at(date(2026, 11, 2), 11)
            s.add("horizon_gt_features.gitea_pull_requests", organization=ORG, repository=repos[0], number=pr_number,
                  title="Across the clock change", body="", author_login=pk(jade)[4:], author_pk=pk(jade),
                  state="open", merged=False, created_at=created, merged_at=None, closed_at=None,
                  base_branch="main", head_branch="feature/dst",
                  html_url=f"https://git.test/{ORG}/{repos[0]}/pulls/{pr_number}", retrieved_at=NOW)
            event_id += 1
            review_id += 1
            s.add("horizon_gt_features.gitea_pr_review_requests", organization=ORG, repository=repos[0],
                  pr_number=pr_number, event_id=event_id, requested_login=pk(pia)[4:], requested_pk=pk(pia),
                  requested_at=requested, retrieved_at=NOW)
            s.add("horizon_gt_features.gitea_pr_reviews", organization=ORG, repository=repos[0], pr_number=pr_number,
                  review_id=review_id, reviewer_login=pk(pia)[4:], reviewer_pk=pk(pia), state="APPROVED",
                  submitted_at=reviewed, retrieved_at=NOW)
            expected.setdefault((pk(pia), project), defaultdict(float))["review_turnaround_hours"] = 49.0
        # Expected review and collaboration values for this project's engineers.
        project_repos = set(repos)
        for engineer in engineers:
            key = (pk(engineer), project)
            if project in ("p-beacon",) or engineer in NO_GIT:
                continue  # Beacon's review bucket is excluded; Milo has no activity rows at all
            expected[key]["prs_reviewed"] = len({p for p in reviews_by[pk(engineer)]
                                                 if p[0] in project_repos and pr_author[p] != pk(engineer)})
            expected[key]["collaborative_prs"] = len({p for p in merged_in_w if p[0] in project_repos
                                                      and pk(engineer) in contributors[p] and len(contributors[p]) >= 2})
            # Real elapsed hours (timestamps), the review if it came by E, else E.
            waits = [((first_review[(pk(engineer), prk)] if first_review.get((pk(engineer), prk), AS_OF + timedelta(1)) <= AS_OF
                       else AS_OF).timestamp() - requested.timestamp()) / 3600
                     for prk, requested in requests_to[pk(engineer)] if prk[0] in project_repos]
            if waits:
                expected[key]["review_turnaround_hours"] = median(waits)
        if project in NO_SOW:
            continue
        owners = [e for e in engineers if e not in NO_GIT]
        owned = defaultdict(list)
        breakdown = uuid.UUID(int=len(project))
        for t in range(6):
            task_id = uuid.uuid4()
            due = WINDOW[0] + timedelta(days=14 + 12 * t)
            completion = rng.choices(["done", "partial", "not_done"], weights=[5, 2, 2])[0]
            if t == 0:
                completion = "not_done"  # an override below marks it done
            task_owners = [pk(o) for o in rng.sample(owners, k=min(len(owners), rng.randint(1, 2)))]
            s.add("horizon_projects.sow_tasks", task_id=task_id, breakdown_id=breakdown, project_pk=project,
                  task_key=f"{project}-T{t + 1}", title=f"Task {t + 1}", description="", acceptance_criteria="",
                  deliverable_type="code", milestone=None, due_date=due, due_date_source="stated",
                  source_ref=f"SOW §{t + 1}", sort_order=t)
            value = {"done": 1.0, "partial": 0.5, "not_done": 0.0}[completion]
            timeline = {"done": "done", "partial": "in_progress", "not_done": "overdue"}[completion]
            s.add("horizon_projects.sow_task_status", run_id=PROJECT_RUN, task_id=task_id, as_of=NOW,
                  completion=completion, completion_value=value, timeline_status=timeline,
                  evidence_state="supported" if completion == "done" else "none",
                  completed_at=due - timedelta(days=1) if completion == "done" else None,
                  owner_pks=task_owners, rationale="seeded")
            s.add("horizon_projects.sow_task_matches", run_id=PROJECT_RUN, task_id=task_id, organization=ORG,
                  repository=repos[0], pr_number=max(1, pr_number - t), confidence="high", reason="seeded")
            if t == 0:
                s.add("horizon_projects.sow_task_overrides", task_id=task_id, completion="done", owner_pks=None,
                      reason="Demoed in class", set_by_pk="stg-exec", set_at=AS_OF - timedelta(days=3))
                value = 1.0
            if due <= AS_OF.date():
                for owner in task_owners:
                    owned[owner].append(value)
        for owner, values in owned.items():
            expected[(owner, project)]["verified_completion"] = fmean(values)
    connection.execute("""INSERT INTO horizon_api.publications (domain, season_type, season_year, run_id, as_of)
                          VALUES ('projects', %s, %s, %s, %s)""", (*SEASON, PROJECT_RUN, AS_OF - timedelta(hours=2)))

    # Activity: weeks with activity over weeks touched, and the longest gap (both ends count).
    weeks = {d.isocalendar()[:2] for d in (WINDOW[0] + timedelta(days=i) for i in range((e_end - WINDOW[0]).days + 1))}
    for key, days in activity_days.items():
        if key[0] == pk(TECH_LEADS[key[1]]):
            continue
        expected.setdefault(key, defaultdict(float))["active_week_ratio"] = len({d.isocalendar()[:2] for d in days}) / len(weeks)
        points = [WINDOW[0], *sorted(days), e_end]
        expected[key]["longest_inactive_stretch"] = max((b - a).days for a, b in zip(points, points[1:]))

    seed_surveys(s, rng, expected)
    connection.execute("CREATE TABLE public.t4_expected (authentik_user_pk TEXT, project_pk TEXT, metric_key TEXT, value DOUBLE PRECISION)")
    with connection.cursor() as cursor:
        cursor.executemany("INSERT INTO public.t4_expected VALUES (%s, %s, %s, %s)",
                           [(*key, metric, value) for key, metrics in expected.items() for metric, value in metrics.items()])
    return dict(s.counts)


def seed_surveys(s: Seed, rng: random.Random, expected: dict) -> None:
    """Two rounds. Tech leads rate their engineers; engineers and project leads
    rate their tech lead. Answers T4.3 must not count are mixed in."""

    rounds = {"stg-2026-09": date(2026, 9, 24), "stg-2026-10": date(2026, 10, 24)}
    for round_id, opens in rounds.items():
        s.add("horizon_gt_features.survey_rounds", round_id=round_id, season_type=SEASON[0], season_year=SEASON[1],
              month=f"{opens:%Y-%m}", opens_at=at(opens, 0), closes_at=at(opens + timedelta(days=6), 23),
              status="closed", retrieved_at=NOW, last_seen_fetch_run_id="stg-fetch-1")
    answers = defaultdict(lambda: defaultdict(list))  # (ratee, project, question) -> round -> values

    def answer(round_id, project, respondent, role, ratee, ratee_role, question, value, counts):
        s.add("horizon_gt_features.survey_answers", response_id=f"{round_id}-{pk(respondent)}-{pk(ratee)}",
              question_key=question, round_id=round_id, project_pk=project, respondent_pk=pk(respondent),
              respondent_role=role, ratee_pk=pk(ratee), ratee_role=ratee_role, value=value,
              submitted_at=at(rounds[round_id] + timedelta(days=2), 14), retrieved_at=NOW,
              last_seen_fetch_run_id="stg-fetch-1")
        if counts and value is not None:
            answers[(pk(ratee), project, question)][round_id].append(value)

    for project in ("p-atlas", "p-beacon"):
        lead, engineers = TECH_LEADS[project], PROJECTS[project][2]
        for round_id in rounds:
            for engineer in engineers:
                for question in ("eng_timeliness", "eng_proactiveness", "eng_design", "eng_collaboration"):
                    answer(round_id, project, lead, "tech_lead", engineer, "engineer", question, rng.randint(1, 3), True)
                # An engineer rating another engineer is not a T4.3 rating (and rating
                # themself never counts), so neither is expected to count.
                answer(round_id, project, engineers[-1], "engineer", engineer, "engineer", "eng_design", 1, False)
                for question in ("lead_proactiveness", "lead_design", "lead_stakeholder", "lead_guidance"):
                    answer(round_id, project, engineer, "engineer", lead, "tech_lead", question, rng.randint(1, 3), True)
            if project in PROJECT_LEADS:
                for question in ("lead_proactiveness", "lead_design", "lead_stakeholder"):
                    answer(round_id, project, PROJECT_LEADS[project], "project_lead", lead, "tech_lead", question, 3, True)
                # Guidance is engineers only: the project lead's answer must not count.
                answer(round_id, project, PROJECT_LEADS[project], "project_lead", lead, "tech_lead", "lead_guidance", 1, False)
    for (ratee, project, question), by_round in answers.items():
        expected.setdefault((ratee, project), defaultdict(float))[question] = fmean(fmean(v) for v in by_round.values())


def main() -> None:
    url = os.environ["HORIZON_DATABASE_URL"]
    with psycopg.connect(url) as connection:
        if connection.execute("SELECT to_regclass('horizon_gt_features.projects')").fetchone()[0]:
            if connection.execute("SELECT count(*) FROM horizon_gt_features.projects").fetchone()[0]:
                raise SystemExit("This database already has projects; seed a fresh one (run-on-staging.sh always starts empty).")
        connection.execute(SCHEMA.read_text())
        connection.execute((HERE / "inputs.sql").read_text())
        # Sessions in New York time, as on a database configured for the club.
        connection.execute(psycopg.sql.SQL("ALTER DATABASE {} SET timezone TO 'America/New_York'").format(
            psycopg.sql.Identifier(connection.info.dbname)))
        counts = seed(connection, random.Random(20261115))
    for table, count in sorted(counts.items()):
        print(f"  {table:<52} {count:>6}")
    print(f"Seeded FALL 2026, as_of {AS_OF.isoformat()}.")


if __name__ == "__main__":
    main()
