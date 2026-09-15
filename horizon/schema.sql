CREATE SCHEMA IF NOT EXISTS gitea_analytics;

CREATE TABLE IF NOT EXISTS gitea_analytics.runs (
    run_id TEXT PRIMARY KEY,
    generated_at TIMESTAMPTZ NOT NULL,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    gitea_url TEXT NOT NULL,
    history_scope TEXT NOT NULL,
    commit_stats_scope TEXT,
    blame_status TEXT NOT NULL DEFAULT 'unknown',
    blame_method TEXT,
    api_calls INTEGER NOT NULL DEFAULT 0,
    warnings JSONB NOT NULL DEFAULT '[]'::JSONB,
    payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS gitea_analytics.organization_snapshots (
    run_id TEXT NOT NULL REFERENCES gitea_analytics.runs(run_id) ON DELETE CASCADE,
    organization TEXT NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, organization)
);

CREATE TABLE IF NOT EXISTS gitea_analytics.member_metrics (
    run_id TEXT NOT NULL REFERENCES gitea_analytics.runs(run_id) ON DELETE CASCADE,
    login TEXT NOT NULL,
    name TEXT,
    email TEXT,
    identity_aliases JSONB NOT NULL DEFAULT '[]'::JSONB,
    organizations TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    admin BOOLEAN NOT NULL DEFAULT FALSE,
    active_account BOOLEAN NOT NULL DEFAULT TRUE,
    roster_member BOOLEAN NOT NULL DEFAULT TRUE,
    service_or_admin BOOLEAN NOT NULL DEFAULT FALSE,
    commits INTEGER,
    non_merge_commits INTEGER,
    merge_commits INTEGER,
    additions BIGINT,
    deletions BIGINT,
    files_changed BIGINT,
    unique_files BIGINT,
    repositories TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    branches TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    pulls_opened INTEGER,
    pulls_merged INTEGER,
    pulls_closed INTEGER,
    reviews_submitted INTEGER,
    reviews_approved INTEGER,
    reviews_changes_requested INTEGER,
    reviews_other INTEGER,
    issues_opened INTEGER,
    active_days INTEGER,
    first_activity TIMESTAMPTZ,
    last_activity TIMESTAMPTZ,
    blame_lines BIGINT,
    blame_files BIGINT,
    PRIMARY KEY (run_id, login)
);

CREATE TABLE IF NOT EXISTS gitea_analytics.repository_snapshots (
    run_id TEXT NOT NULL REFERENCES gitea_analytics.runs(run_id) ON DELETE CASCADE,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    default_branch TEXT,
    html_url TEXT,
    clone_url TEXT,
    ssh_url TEXT,
    branches TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    issue_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, organization, repository)
);

CREATE TABLE IF NOT EXISTS gitea_analytics.commit_metrics (
    run_id TEXT NOT NULL REFERENCES gitea_analytics.runs(run_id) ON DELETE CASCADE,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    sha TEXT NOT NULL,
    author_login TEXT NOT NULL,
    committed_at TIMESTAMPTZ,
    branches TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    total BIGINT,
    additions BIGINT,
    deletions BIGINT,
    PRIMARY KEY (run_id, organization, repository, sha),
    FOREIGN KEY (run_id, organization, repository)
        REFERENCES gitea_analytics.repository_snapshots(run_id, organization, repository)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gitea_analytics.pull_request_metrics (
    run_id TEXT NOT NULL REFERENCES gitea_analytics.runs(run_id) ON DELETE CASCADE,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT,
    author_login TEXT NOT NULL,
    state TEXT,
    merged BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (run_id, organization, repository, number),
    FOREIGN KEY (run_id, organization, repository)
        REFERENCES gitea_analytics.repository_snapshots(run_id, organization, repository)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gitea_analytics.pull_request_reviews (
    run_id TEXT NOT NULL,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    review_index INTEGER NOT NULL,
    reviewer_login TEXT NOT NULL,
    state TEXT,
    PRIMARY KEY (run_id, organization, repository, pull_number, review_index),
    FOREIGN KEY (run_id, organization, repository, pull_number)
        REFERENCES gitea_analytics.pull_request_metrics(run_id, organization, repository, number)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gitea_analytics.issue_metrics (
    run_id TEXT NOT NULL REFERENCES gitea_analytics.runs(run_id) ON DELETE CASCADE,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT,
    author_login TEXT NOT NULL,
    state TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    html_url TEXT,
    PRIMARY KEY (run_id, organization, repository, number),
    FOREIGN KEY (run_id, organization, repository)
        REFERENCES gitea_analytics.repository_snapshots(run_id, organization, repository)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gitea_analytics.run_artifacts (
    run_id TEXT NOT NULL REFERENCES gitea_analytics.runs(run_id) ON DELETE CASCADE,
    artifact_name TEXT NOT NULL,
    content TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (run_id, artifact_name)
);

ALTER TABLE gitea_analytics.member_metrics
    ADD COLUMN IF NOT EXISTS roster_member BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE gitea_analytics.member_metrics
    ADD COLUMN IF NOT EXISTS identity_aliases JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE gitea_analytics.runs
    ADD COLUMN IF NOT EXISTS blame_status TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE gitea_analytics.runs
    ALTER COLUMN blame_method DROP NOT NULL;

ALTER TABLE gitea_analytics.member_metrics
    ALTER COLUMN blame_lines DROP NOT NULL,
    ALTER COLUMN blame_files DROP NOT NULL;

CREATE INDEX IF NOT EXISTS member_metrics_latest_login_idx
    ON gitea_analytics.member_metrics (login, run_id);
CREATE INDEX IF NOT EXISTS member_metrics_organizations_gin_idx
    ON gitea_analytics.member_metrics USING GIN (organizations);
CREATE INDEX IF NOT EXISTS repository_snapshots_latest_org_idx
    ON gitea_analytics.repository_snapshots (organization, run_id);
CREATE INDEX IF NOT EXISTS commit_metrics_latest_author_idx
    ON gitea_analytics.commit_metrics (author_login, run_id);
CREATE INDEX IF NOT EXISTS pull_request_metrics_latest_author_idx
    ON gitea_analytics.pull_request_metrics (author_login, run_id);
CREATE INDEX IF NOT EXISTS pull_request_reviews_latest_reviewer_idx
    ON gitea_analytics.pull_request_reviews (reviewer_login, run_id);
CREATE INDEX IF NOT EXISTS issue_metrics_latest_author_idx
    ON gitea_analytics.issue_metrics (author_login, run_id);


-- v2 canonical activity and availability fields shared with the API/export.
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS commits_default_reachable BIGINT;
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS commits_branch_only BIGINT;
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS pulls_contributed_to BIGINT;
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS pulls_merged_contributed_to BIGINT;
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS pull_commits_authored BIGINT;
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS merged_pull_commits_authored BIGINT;
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS availability JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS observed_values JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS commit_stats_status TEXT;
ALTER TABLE gitea_analytics.member_metrics ADD COLUMN IF NOT EXISTS file_stats_status TEXT;
CREATE OR REPLACE VIEW gitea_analytics.latest_run AS
SELECT r.*
FROM gitea_analytics.runs AS r
ORDER BY r.generated_at DESC, r.run_id DESC
LIMIT 1;

CREATE OR REPLACE VIEW gitea_analytics.latest_member_metrics AS
SELECT m.*
FROM gitea_analytics.member_metrics AS m
JOIN gitea_analytics.latest_run AS r USING (run_id);

CREATE OR REPLACE VIEW gitea_analytics.latest_repository_snapshots AS
SELECT repo.*
FROM gitea_analytics.repository_snapshots AS repo
JOIN gitea_analytics.latest_run AS r USING (run_id);

-- v2: unknown activity must remain NULL in existing deployments as well.
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN commits DROP NOT NULL, ALTER COLUMN commits DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN non_merge_commits DROP NOT NULL, ALTER COLUMN non_merge_commits DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN merge_commits DROP NOT NULL, ALTER COLUMN merge_commits DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN additions DROP NOT NULL, ALTER COLUMN additions DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN deletions DROP NOT NULL, ALTER COLUMN deletions DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN files_changed DROP NOT NULL, ALTER COLUMN files_changed DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN unique_files DROP NOT NULL, ALTER COLUMN unique_files DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN pulls_opened DROP NOT NULL, ALTER COLUMN pulls_opened DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN pulls_merged DROP NOT NULL, ALTER COLUMN pulls_merged DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN pulls_closed DROP NOT NULL, ALTER COLUMN pulls_closed DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN reviews_submitted DROP NOT NULL, ALTER COLUMN reviews_submitted DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN reviews_approved DROP NOT NULL, ALTER COLUMN reviews_approved DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN reviews_changes_requested DROP NOT NULL, ALTER COLUMN reviews_changes_requested DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN reviews_other DROP NOT NULL, ALTER COLUMN reviews_other DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN issues_opened DROP NOT NULL, ALTER COLUMN issues_opened DROP DEFAULT;
ALTER TABLE gitea_analytics.member_metrics ALTER COLUMN active_days DROP NOT NULL, ALTER COLUMN active_days DROP DEFAULT;
ALTER TABLE gitea_analytics.commit_metrics ALTER COLUMN total DROP NOT NULL, ALTER COLUMN total DROP DEFAULT;
ALTER TABLE gitea_analytics.commit_metrics ALTER COLUMN additions DROP NOT NULL, ALTER COLUMN additions DROP DEFAULT;
ALTER TABLE gitea_analytics.commit_metrics ALTER COLUMN deletions DROP NOT NULL, ALTER COLUMN deletions DROP DEFAULT;
