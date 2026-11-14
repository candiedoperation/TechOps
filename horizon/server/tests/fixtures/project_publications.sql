-- Provisional T5.8 contract. This DDL is for disposable PostgreSQL fixtures only.
CREATE SCHEMA IF NOT EXISTS horizon_api;
CREATE SCHEMA IF NOT EXISTS horizon_projects;

CREATE TABLE IF NOT EXISTS horizon_api.publications (
    domain text NOT NULL,
    season_type text NOT NULL,
    season_year integer NOT NULL,
    run_id uuid NOT NULL,
    as_of timestamptz NOT NULL,
    PRIMARY KEY (domain, season_type, season_year)
);

CREATE TABLE IF NOT EXISTS horizon_api.project_summaries (
    run_id uuid NOT NULL,
    as_of timestamptz NOT NULL,
    season_type text NOT NULL,
    season_year integer NOT NULL,
    project_pk text NOT NULL,
    friendly_name text NOT NULL,
    window_start date NOT NULL,
    window_end date NOT NULL,
    has_sow boolean NOT NULL,
    tasks_total integer NOT NULL,
    tasks_due integer NOT NULL,
    tasks_done integer NOT NULL,
    tasks_partial integer NOT NULL,
    tasks_overdue integer NOT NULL,
    percent_complete numeric NOT NULL,
    risk_counts jsonb NOT NULL,
    member_pks text[] NOT NULL,
    leadership_pks text[] NOT NULL,
    PRIMARY KEY (run_id, project_pk)
);

CREATE TABLE IF NOT EXISTS horizon_api.project_detail (
    run_id uuid NOT NULL,
    project_pk text NOT NULL,
    document jsonb NOT NULL,
    PRIMARY KEY (run_id, project_pk)
);

CREATE TABLE IF NOT EXISTS horizon_api.project_sow_timeline (
    run_id uuid NOT NULL,
    project_pk text NOT NULL,
    document jsonb NOT NULL,
    PRIMARY KEY (run_id, project_pk)
);

CREATE TABLE IF NOT EXISTS horizon_projects.sow_task_overrides (
    override_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_pk text NOT NULL,
    task_key text NOT NULL,
    status text NOT NULL,
    reason text NOT NULL,
    set_at timestamptz NOT NULL
);

GRANT USAGE ON SCHEMA horizon_api, horizon_projects TO horizon_projects_fixture_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA horizon_api TO horizon_projects_fixture_reader;
GRANT SELECT (override_id, project_pk, task_key, status, reason, set_at)
    ON horizon_projects.sow_task_overrides TO horizon_projects_fixture_reader;
