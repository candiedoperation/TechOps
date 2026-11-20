-- Stand-ins for the Track 4 input tables that other tracks own and that are not
-- on master yet: the T1.1 roster and Gitea PR tables, the T2.5 blame summary,
-- the T2.6 commit history (member_commit_activity is its view), the T3.4
-- surveys and the T5.3/T5.4 SOW tables.
--
-- Copied with pg_dump from the deployed Horizon schema on 2026-11-20, so the
-- staging run sees the production column names, types, NOT NULLs and CHECKs.
-- Only the foreign keys to Track 5 tables that are not stood in for
-- (sow_breakdowns, project_runs) are left out. For a throwaway database only.

CREATE SCHEMA IF NOT EXISTS horizon_projects;



SET statement_timeout = 0;

CREATE TABLE IF NOT EXISTS horizon_projects.sow_task_overrides (
    override_id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    completion text,
    owner_pks text[],
    reason text NOT NULL,
    set_by_pk text NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sow_task_overrides_completion_check CHECK ((completion = ANY (ARRAY['done'::text, 'partial'::text, 'not_done'::text])))
);

CREATE TABLE IF NOT EXISTS horizon_projects.sow_tasks (
    task_id uuid DEFAULT gen_random_uuid() NOT NULL,
    breakdown_id uuid NOT NULL,
    project_pk text NOT NULL,
    task_key text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    acceptance_criteria text NOT NULL,
    deliverable_type text NOT NULL,
    milestone text,
    due_date date,
    due_date_source text NOT NULL,
    source_ref text NOT NULL,
    sort_order integer NOT NULL,
    assignee_pks text[] DEFAULT '{}'::text[] NOT NULL,
    assignee_evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT sow_tasks_deliverable_type_check CHECK ((deliverable_type = ANY (ARRAY['code'::text, 'design'::text, 'documentation'::text, 'research'::text, 'other'::text]))),
    CONSTRAINT sow_tasks_due_date_source_check CHECK ((due_date_source = ANY (ARRAY['stated'::text, 'inferred'::text, 'none'::text])))
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.blame_commit_summary (
    run_id text NOT NULL,
    organization text NOT NULL,
    repository text NOT NULL,
    blamed_file_path text NOT NULL,
    commit_sha text NOT NULL,
    author_name text NOT NULL,
    author_email text NOT NULL,
    authentik_user_pk text,
    identity_resolution text NOT NULL,
    authored_at timestamp with time zone NOT NULL,
    eligible boolean NOT NULL,
    eligibility_reason text NOT NULL,
    reaches_history_boundary boolean NOT NULL,
    line_count integer NOT NULL,
    CONSTRAINT blame_commit_summary_identity_resolution_check CHECK ((identity_resolution = ANY (ARRAY['directory_email'::text, 'ambiguous_email'::text, 'unmatched'::text]))),
    CONSTRAINT blame_commit_summary_line_count_check CHECK ((line_count > 0))
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.git_commit_coauthors (
    organization text NOT NULL,
    repository text NOT NULL,
    commit_sha text NOT NULL,
    coauthor_name text NOT NULL,
    coauthor_email text NOT NULL,
    authentik_user_pk text,
    identity_resolution text NOT NULL,
    CONSTRAINT git_commit_coauthors_identity_resolution_check CHECK ((identity_resolution = ANY (ARRAY['directory_email'::text, 'ambiguous_email'::text, 'unmatched'::text])))
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.git_commits (
    organization text NOT NULL,
    repository text NOT NULL,
    commit_sha text NOT NULL,
    parent_shas text[] NOT NULL,
    author_name text NOT NULL,
    author_email text NOT NULL,
    authentik_user_pk text,
    identity_resolution text NOT NULL,
    authored_at timestamp with time zone NOT NULL,
    committer_name text NOT NULL,
    committer_email text NOT NULL,
    committed_at timestamp with time zone NOT NULL,
    subject text NOT NULL,
    files_changed integer NOT NULL,
    lines_added integer NOT NULL,
    lines_deleted integer NOT NULL,
    eligible_lines_added integer NOT NULL,
    eligible_lines_deleted integer NOT NULL,
    on_default_branch boolean NOT NULL,
    first_seen_run_id text NOT NULL,
    last_seen_run_id text NOT NULL,
    CONSTRAINT git_commits_identity_resolution_check CHECK ((identity_resolution = ANY (ARRAY['directory_email'::text, 'ambiguous_email'::text, 'unmatched'::text])))
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.gitea_pr_review_requests (
    organization text NOT NULL,
    repository text NOT NULL,
    pr_number bigint NOT NULL,
    event_id bigint NOT NULL,
    requested_login text NOT NULL,
    requested_pk text,
    requested_at timestamp with time zone NOT NULL,
    retrieved_at timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.gitea_pr_reviews (
    organization text NOT NULL,
    repository text NOT NULL,
    pr_number bigint NOT NULL,
    review_id bigint NOT NULL,
    reviewer_login text NOT NULL,
    reviewer_pk text,
    state text NOT NULL,
    submitted_at timestamp with time zone,
    retrieved_at timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.gitea_pull_requests (
    organization text NOT NULL,
    repository text NOT NULL,
    number bigint NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    author_login text NOT NULL,
    author_pk text,
    state text NOT NULL,
    merged boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    merged_at timestamp with time zone,
    closed_at timestamp with time zone,
    base_branch text,
    head_branch text,
    html_url text NOT NULL,
    retrieved_at timestamp with time zone NOT NULL,
    CONSTRAINT gitea_pull_requests_state_check CHECK ((state = ANY (ARRAY['open'::text, 'closed'::text])))
);

CREATE OR REPLACE VIEW horizon_gt_features.member_commit_activity AS
 WITH credited AS (
         SELECT g.organization,
            g.repository,
            g.commit_sha,
            g.authentik_user_pk,
            'author'::text AS credit,
            g.authored_at AS activity_at,
            'default_branch'::text AS source,
            (g.eligible_lines_added + g.eligible_lines_deleted) AS eligible_lines_changed,
            0 AS priority
           FROM horizon_gt_features.git_commits g
          WHERE (g.on_default_branch AND (g.authentik_user_pk IS NOT NULL))
        UNION ALL
         SELECT c.organization,
            c.repository,
            c.commit_sha,
            c.authentik_user_pk,
            'co_author'::text,
            g.authored_at,
            'default_branch'::text,
            (g.eligible_lines_added + g.eligible_lines_deleted),
            1
           FROM (horizon_gt_features.git_commit_coauthors c
             JOIN horizon_gt_features.git_commits g USING (organization, repository, commit_sha))
          WHERE (g.on_default_branch AND (c.authentik_user_pk IS NOT NULL))
        UNION ALL
         SELECT p.organization,
            p.repository,
            p.commit_sha,
            p.authentik_user_pk,
            'author'::text,
            p.committed_at,
            'pr_branch'::text,
            NULL::integer AS int4,
            2
           FROM ( SELECT DISTINCT ON (pr_linked_commit_messages.organization, pr_linked_commit_messages.repository, pr_linked_commit_messages.commit_sha) pr_linked_commit_messages.organization,
                    pr_linked_commit_messages.repository,
                    pr_linked_commit_messages.pull_request_number,
                    pr_linked_commit_messages.commit_sha,
                    pr_linked_commit_messages.author_name,
                    pr_linked_commit_messages.author_email,
                    pr_linked_commit_messages.authentik_user_pk,
                    pr_linked_commit_messages.identity_resolution,
                    pr_linked_commit_messages.candidate_count,
                    pr_linked_commit_messages.committed_at,
                    pr_linked_commit_messages.message,
                    pr_linked_commit_messages.dagster_run_id
                   FROM horizon_gt_features.pr_linked_commit_messages
                  ORDER BY pr_linked_commit_messages.organization, pr_linked_commit_messages.repository, pr_linked_commit_messages.commit_sha, (pr_linked_commit_messages.authentik_user_pk IS NULL)) p
          WHERE ((p.authentik_user_pk IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
                   FROM horizon_gt_features.git_commits g
                  WHERE ((g.organization = p.organization) AND (g.repository = p.repository) AND (g.commit_sha = p.commit_sha) AND g.on_default_branch)))))
        ), dedup AS (
         SELECT DISTINCT ON (credited.organization, credited.repository, credited.commit_sha, credited.authentik_user_pk) credited.organization,
            credited.repository,
            credited.commit_sha,
            credited.authentik_user_pk,
            credited.credit,
            credited.activity_at,
            credited.source,
            credited.eligible_lines_changed
           FROM credited
          ORDER BY credited.organization, credited.repository, credited.commit_sha, credited.authentik_user_pk, credited.priority
        )
 SELECT organization,
    repository,
    commit_sha,
    authentik_user_pk,
    credit,
    activity_at,
    source,
    eligible_lines_changed
   FROM dedup;

CREATE TABLE IF NOT EXISTS horizon_gt_features.project_members (
    project_pk text NOT NULL,
    authentik_user_pk text NOT NULL,
    username text,
    email text,
    display_name text,
    roles text[] NOT NULL,
    role_titles jsonb NOT NULL,
    tenure_semesters integer NOT NULL,
    role_mapping_version text NOT NULL,
    retrieved_at timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.project_repositories (
    project_pk text,
    organization text NOT NULL,
    repository text NOT NULL,
    default_branch text,
    retrieved_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.projects (
    project_pk text NOT NULL,
    season_type text NOT NULL,
    season_year integer NOT NULL,
    name text NOT NULL,
    gitea_org text NOT NULL,
    friendly_name text NOT NULL,
    window_start date NOT NULL,
    window_end date NOT NULL,
    archived boolean NOT NULL,
    retrieved_at timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.survey_answers (
    response_id text NOT NULL,
    question_key text NOT NULL,
    round_id text NOT NULL,
    project_pk text NOT NULL,
    respondent_pk text NOT NULL,
    respondent_role text NOT NULL,
    ratee_pk text NOT NULL,
    ratee_role text NOT NULL,
    value smallint,
    submitted_at timestamp with time zone NOT NULL,
    retrieved_at timestamp with time zone NOT NULL,
    last_seen_fetch_run_id text NOT NULL,
    CONSTRAINT survey_answers_value_check CHECK ((value = ANY (ARRAY[1, 2, 3])))
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.survey_rounds (
    round_id text NOT NULL,
    season_type text NOT NULL,
    season_year integer NOT NULL,
    month text NOT NULL,
    opens_at timestamp with time zone NOT NULL,
    closes_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    retrieved_at timestamp with time zone NOT NULL,
    last_seen_fetch_run_id text NOT NULL,
    CONSTRAINT survey_rounds_season_type_check CHECK ((season_type = ANY (ARRAY['FALL'::text, 'SPRING'::text]))),
    CONSTRAINT survey_rounds_season_year_check CHECK (((season_year >= 2000) AND (season_year <= 2200))),
    CONSTRAINT survey_rounds_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'open'::text, 'closed'::text])))
);

CREATE TABLE IF NOT EXISTS horizon_projects.sow_task_matches (
    run_id text NOT NULL,
    task_id uuid NOT NULL,
    organization text NOT NULL,
    repository text NOT NULL,
    pr_number bigint NOT NULL,
    confidence text NOT NULL,
    reason text NOT NULL,
    CONSTRAINT sow_task_matches_confidence_check CHECK ((confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT sow_task_matches_pr_number_check CHECK ((pr_number > 0))
);

CREATE TABLE IF NOT EXISTS horizon_projects.sow_task_status (
    run_id text NOT NULL,
    task_id uuid NOT NULL,
    as_of timestamp with time zone NOT NULL,
    completion text NOT NULL,
    completion_value double precision NOT NULL,
    timeline_status text NOT NULL,
    evidence_state text NOT NULL,
    completed_at timestamp with time zone,
    owner_pks text[] DEFAULT '{}'::text[] NOT NULL,
    rationale text NOT NULL,
    CONSTRAINT sow_task_status_check CHECK ((((completion = 'done'::text) AND (completion_value = (1)::double precision) AND (timeline_status = 'done'::text)) OR ((completion = 'partial'::text) AND (completion_value = (0.5)::double precision) AND (timeline_status = ANY (ARRAY['in_progress'::text, 'overdue'::text]))) OR ((completion = 'not_done'::text) AND (completion_value = (0)::double precision) AND (timeline_status = ANY (ARRAY['not_started'::text, 'overdue'::text, 'in_progress'::text]))))),
    CONSTRAINT sow_task_status_check1 CHECK (((completed_at IS NULL) OR (completion = 'done'::text))),
    CONSTRAINT sow_task_status_completion_check CHECK ((completion = ANY (ARRAY['done'::text, 'partial'::text, 'not_done'::text]))),
    CONSTRAINT sow_task_status_completion_value_check CHECK ((completion_value = ANY (ARRAY[(0)::double precision, (0.5)::double precision, (1)::double precision]))),
    CONSTRAINT sow_task_status_evidence_state_check CHECK ((evidence_state = ANY (ARRAY['supported'::text, 'uncertain'::text, 'none'::text]))),
    CONSTRAINT sow_task_status_timeline_status_check CHECK ((timeline_status = ANY (ARRAY['done'::text, 'in_progress'::text, 'not_started'::text, 'overdue'::text])))
);

ALTER TABLE ONLY horizon_gt_features.blame_commit_summary
    ADD CONSTRAINT blame_commit_summary_pkey PRIMARY KEY (run_id, organization, repository, blamed_file_path, commit_sha);

ALTER TABLE ONLY horizon_gt_features.git_commit_coauthors
    ADD CONSTRAINT git_commit_coauthors_pkey PRIMARY KEY (organization, repository, commit_sha, coauthor_email);

ALTER TABLE ONLY horizon_gt_features.git_commits
    ADD CONSTRAINT git_commits_pkey PRIMARY KEY (organization, repository, commit_sha);

ALTER TABLE ONLY horizon_gt_features.gitea_pr_review_requests
    ADD CONSTRAINT gitea_pr_review_requests_pkey PRIMARY KEY (organization, repository, pr_number, event_id);

ALTER TABLE ONLY horizon_gt_features.gitea_pr_reviews
    ADD CONSTRAINT gitea_pr_reviews_pkey PRIMARY KEY (organization, repository, pr_number, review_id);

ALTER TABLE ONLY horizon_gt_features.gitea_pull_requests
    ADD CONSTRAINT gitea_pull_requests_pkey PRIMARY KEY (organization, repository, number);

ALTER TABLE ONLY horizon_gt_features.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (project_pk, authentik_user_pk);

ALTER TABLE ONLY horizon_gt_features.project_repositories
    ADD CONSTRAINT project_repositories_pkey PRIMARY KEY (organization, repository);

ALTER TABLE ONLY horizon_gt_features.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (project_pk);

ALTER TABLE ONLY horizon_gt_features.survey_answers
    ADD CONSTRAINT survey_answers_pkey PRIMARY KEY (response_id, question_key);

ALTER TABLE ONLY horizon_gt_features.survey_rounds
    ADD CONSTRAINT survey_rounds_pkey PRIMARY KEY (round_id);

ALTER TABLE ONLY horizon_projects.sow_task_matches
    ADD CONSTRAINT sow_task_matches_pkey PRIMARY KEY (run_id, task_id, organization, repository, pr_number);

ALTER TABLE ONLY horizon_projects.sow_task_overrides
    ADD CONSTRAINT sow_task_overrides_pkey PRIMARY KEY (override_id);

ALTER TABLE ONLY horizon_projects.sow_task_status
    ADD CONSTRAINT sow_task_status_pkey PRIMARY KEY (run_id, task_id);

ALTER TABLE ONLY horizon_projects.sow_tasks
    ADD CONSTRAINT sow_tasks_breakdown_id_task_key_key UNIQUE (breakdown_id, task_key);

ALTER TABLE ONLY horizon_projects.sow_tasks
    ADD CONSTRAINT sow_tasks_pkey PRIMARY KEY (task_id);

CREATE INDEX IF NOT EXISTS blame_commit_summary_member_idx ON horizon_gt_features.blame_commit_summary USING btree (run_id, authentik_user_pk) WHERE eligible;

CREATE INDEX IF NOT EXISTS blame_commit_summary_repo_idx ON horizon_gt_features.blame_commit_summary USING btree (organization, repository, run_id);

CREATE INDEX IF NOT EXISTS git_commits_member_idx ON horizon_gt_features.git_commits USING btree (authentik_user_pk, authored_at);

CREATE INDEX IF NOT EXISTS gitea_pr_reviews_reviewer_idx ON horizon_gt_features.gitea_pr_reviews USING btree (reviewer_pk) WHERE (reviewer_pk IS NOT NULL);

CREATE INDEX IF NOT EXISTS gitea_pull_requests_author_idx ON horizon_gt_features.gitea_pull_requests USING btree (author_pk) WHERE (author_pk IS NOT NULL);

CREATE INDEX IF NOT EXISTS project_members_member_idx ON horizon_gt_features.project_members USING btree (authentik_user_pk);

CREATE INDEX IF NOT EXISTS project_repositories_project_idx ON horizon_gt_features.project_repositories USING btree (project_pk);

CREATE INDEX IF NOT EXISTS projects_season_idx ON horizon_gt_features.projects USING btree (season_type, season_year);

CREATE INDEX IF NOT EXISTS survey_answers_fetch_idx ON horizon_gt_features.survey_answers USING btree (last_seen_fetch_run_id);

CREATE INDEX IF NOT EXISTS survey_answers_ratee_question_idx ON horizon_gt_features.survey_answers USING btree (project_pk, ratee_pk, question_key, round_id);

CREATE INDEX IF NOT EXISTS survey_rounds_season_idx ON horizon_gt_features.survey_rounds USING btree (season_type, season_year, last_seen_fetch_run_id);

CREATE INDEX IF NOT EXISTS sow_task_matches_task_idx ON horizon_projects.sow_task_matches USING btree (task_id, run_id);

CREATE INDEX IF NOT EXISTS sow_task_overrides_latest_idx ON horizon_projects.sow_task_overrides USING btree (task_id, set_at DESC, override_id DESC);

CREATE INDEX IF NOT EXISTS sow_tasks_project_idx ON horizon_projects.sow_tasks USING btree (project_pk, breakdown_id);

ALTER TABLE ONLY horizon_gt_features.blame_commit_summary
    ADD CONSTRAINT blame_commit_summary_run_id_fkey FOREIGN KEY (run_id) REFERENCES horizon_gt_features.pipeline_runs(run_id);

ALTER TABLE ONLY horizon_gt_features.git_commit_coauthors
    ADD CONSTRAINT git_commit_coauthors_organization_repository_commit_sha_fkey FOREIGN KEY (organization, repository, commit_sha) REFERENCES horizon_gt_features.git_commits(organization, repository, commit_sha) ON DELETE CASCADE;

ALTER TABLE ONLY horizon_gt_features.project_members
    ADD CONSTRAINT project_members_project_pk_fkey FOREIGN KEY (project_pk) REFERENCES horizon_gt_features.projects(project_pk);

ALTER TABLE ONLY horizon_gt_features.survey_answers
    ADD CONSTRAINT survey_answers_round_id_fkey FOREIGN KEY (round_id) REFERENCES horizon_gt_features.survey_rounds(round_id);

ALTER TABLE ONLY horizon_projects.sow_task_matches
    ADD CONSTRAINT sow_task_matches_task_id_fkey FOREIGN KEY (task_id) REFERENCES horizon_projects.sow_tasks(task_id);

ALTER TABLE ONLY horizon_projects.sow_task_overrides
    ADD CONSTRAINT sow_task_overrides_task_id_fkey FOREIGN KEY (task_id) REFERENCES horizon_projects.sow_tasks(task_id);

ALTER TABLE ONLY horizon_projects.sow_task_status
    ADD CONSTRAINT sow_task_status_task_id_fkey FOREIGN KEY (task_id) REFERENCES horizon_projects.sow_tasks(task_id);

