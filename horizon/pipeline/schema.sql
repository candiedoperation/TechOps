-- Horizon-owned pipeline data lives in its own schema. Run-scoped keys make
-- snapshots repeatable and keep concurrent Dagster runs from overwriting one
-- another. Consumers should use only runs with status = 'complete'.

CREATE SCHEMA IF NOT EXISTS horizon_gt_features;

CREATE TABLE IF NOT EXISTS horizon_gt_features.pipeline_runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    source_commit_sha TEXT NOT NULL,
    source_retrieved_at TIMESTAMPTZ NOT NULL,
    files_tracked INTEGER NOT NULL CHECK (files_tracked >= 0),
    files_captured INTEGER NOT NULL CHECK (files_captured >= 0),
    files_skipped_binary INTEGER NOT NULL CHECK (files_skipped_binary >= 0),
    files_empty INTEGER NOT NULL CHECK (files_empty >= 0),
    files_failed INTEGER NOT NULL CHECK (files_failed >= 0),
    roster_source TEXT NOT NULL,
    roster_retrieved_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    persisted_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT pipeline_runs_files_accounted_check
        CHECK (files_tracked = files_captured + files_skipped_binary + files_empty + files_failed),
    CONSTRAINT pipeline_runs_status_allowed_check
        CHECK (status IN ('incomplete', 'complete')),
    CONSTRAINT pipeline_runs_completion_check
        CHECK ((status = 'incomplete' AND completed_at IS NULL) OR
               (status = 'complete' AND completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS pipeline_runs_repository_idx
    ON horizon_gt_features.pipeline_runs (organization, repository, started_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_runs_complete_idx
    ON horizon_gt_features.pipeline_runs (completed_at DESC, organization, repository)
    WHERE status = 'complete';

-- One row per surviving source line. Full porcelain fields are retained for
-- re-analysis; run_id joins to pipeline_runs for the source commit and fetch time.
CREATE TABLE IF NOT EXISTS horizon_gt_features.blame_records (
    run_id TEXT NOT NULL REFERENCES horizon_gt_features.pipeline_runs(run_id),
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    blamed_file_path TEXT NOT NULL,
    line_number_in_file INTEGER NOT NULL CHECK (line_number_in_file > 0),
    commit_sha TEXT NOT NULL,
    commit_summary TEXT NOT NULL,
    consecutive_line_count INTEGER CHECK (consecutive_line_count > 0),
    line_number_at_origin INTEGER NOT NULL CHECK (line_number_at_origin > 0),
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    authored_at_epoch BIGINT NOT NULL,
    author_utc_offset TEXT NOT NULL,
    committer_name TEXT NOT NULL,
    committer_email TEXT NOT NULL,
    committed_at_epoch BIGINT NOT NULL,
    committer_utc_offset TEXT NOT NULL,
    origin_file_path TEXT NOT NULL,
    previous_commit_sha TEXT,
    previous_file_path TEXT,
    reaches_history_boundary BOOLEAN NOT NULL,
    authentik_user_pk TEXT,
    identity_resolution TEXT NOT NULL CHECK (
        identity_resolution IN ('directory_email', 'ambiguous_email', 'unmatched')
    ),
    PRIMARY KEY (run_id, organization, repository, blamed_file_path, line_number_in_file)
);

CREATE INDEX IF NOT EXISTS blame_records_member_idx
    ON horizon_gt_features.blame_records (run_id, authentik_user_pk)
    WHERE authentik_user_pk IS NOT NULL;
CREATE INDEX IF NOT EXISTS blame_records_commit_idx
    ON horizon_gt_features.blame_records (run_id, organization, repository, commit_sha);

-- Each existing metric table is a run snapshot. Re-running a step replaces
-- only that run's rows, including replacing them with an empty result.
CREATE TABLE IF NOT EXISTS horizon_gt_features.file_ownership (
    run_id TEXT NOT NULL,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    file_path TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    surviving_lines INTEGER NOT NULL CHECK (surviving_lines > 0),
    file_lines INTEGER NOT NULL CHECK (file_lines > 0),
    ownership_share DOUBLE PRECISION NOT NULL CHECK (ownership_share >= 0 AND ownership_share <= 1),
    PRIMARY KEY (run_id, organization, repository, file_path, author_name, author_email)
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.member_repository_ownership (
    run_id TEXT NOT NULL,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    surviving_lines INTEGER NOT NULL CHECK (surviving_lines > 0),
    repository_lines INTEGER NOT NULL CHECK (repository_lines > 0),
    ownership_share DOUBLE PRECISION NOT NULL CHECK (ownership_share >= 0 AND ownership_share <= 1),
    files_owned INTEGER NOT NULL CHECK (files_owned > 0),
    majority_owned_files INTEGER NOT NULL CHECK (majority_owned_files >= 0),
    rank INTEGER NOT NULL CHECK (rank > 0),
    PRIMARY KEY (run_id, organization, repository, author_name, author_email)
);

CREATE TABLE IF NOT EXISTS horizon_gt_features.member_ownership (
    run_id TEXT NOT NULL,
    organization TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    surviving_lines INTEGER NOT NULL CHECK (surviving_lines > 0),
    surviving_commits INTEGER NOT NULL CHECK (surviving_commits >= 0),
    files_owned INTEGER NOT NULL CHECK (files_owned > 0),
    repositories INTEGER NOT NULL CHECK (repositories > 0),
    majority_owned_files INTEGER NOT NULL CHECK (majority_owned_files >= 0),
    average_file_share DOUBLE PRECISION NOT NULL CHECK (average_file_share >= 0 AND average_file_share <= 1),
    PRIMARY KEY (run_id, organization, author_name, author_email)
);

CREATE INDEX IF NOT EXISTS file_ownership_repository_idx
    ON horizon_gt_features.file_ownership (run_id, organization, repository);
CREATE INDEX IF NOT EXISTS member_repository_ownership_repository_idx
    ON horizon_gt_features.member_repository_ownership (run_id, organization, repository);
CREATE INDEX IF NOT EXISTS member_ownership_identity_idx
    ON horizon_gt_features.member_ownership (run_id, organization, author_email);

CREATE TABLE IF NOT EXISTS horizon_gt_features.member_roster_snapshot (
    run_id TEXT NOT NULL,
    authentik_user_pk TEXT NOT NULL,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL,
    retrieved_at TIMESTAMPTZ NOT NULL,
    source_name TEXT NOT NULL,
    PRIMARY KEY (run_id, authentik_user_pk)
);
CREATE INDEX IF NOT EXISTS member_roster_snapshot_email_idx
    ON horizon_gt_features.member_roster_snapshot (run_id, email)
    INCLUDE (authentik_user_pk);
CREATE INDEX IF NOT EXISTS member_roster_snapshot_username_idx
    ON horizon_gt_features.member_roster_snapshot (run_id, username)
    INCLUDE (authentik_user_pk);

CREATE TABLE IF NOT EXISTS horizon_gt_features.git_identity_mapping (
    run_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    authentik_user_pk TEXT,
    match_method TEXT NOT NULL CHECK (
        match_method IN ('directory_email', 'ambiguous_email', 'unmatched')
    ),
    candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
    evidence_sources TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    blame_line_count BIGINT NOT NULL DEFAULT 0
        CONSTRAINT git_identity_blame_count_check CHECK (blame_line_count >= 0),
    pull_request_commit_count BIGINT NOT NULL DEFAULT 0
        CONSTRAINT git_identity_pr_count_check CHECK (pull_request_commit_count >= 0),
    source_name TEXT NOT NULL,
    source_retrieved_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (run_id, author_name, author_email)
);
CREATE INDEX IF NOT EXISTS git_identity_mapping_member_idx
    ON horizon_gt_features.git_identity_mapping (run_id, authentik_user_pk);

CREATE TABLE IF NOT EXISTS horizon_gt_features.eligible_file_ownership (
    run_id TEXT NOT NULL,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    file_path TEXT NOT NULL,
    authentik_user_pk TEXT,
    identity_resolution TEXT NOT NULL CHECK (
        identity_resolution IN ('directory_email', 'ambiguous_email', 'unmatched')
    ),
    identity_key TEXT NOT NULL,
    raw_author_identities_json JSONB NOT NULL,
    eligible_source_lines INTEGER NOT NULL CHECK (eligible_source_lines > 0),
    eligible_file_lines INTEGER NOT NULL CHECK (eligible_file_lines > 0),
    non_boundary_source_lines INTEGER NOT NULL CHECK (
        non_boundary_source_lines >= 0 AND non_boundary_source_lines <= eligible_source_lines
    ),
    ownership_share DOUBLE PRECISION NOT NULL CHECK (ownership_share >= 0 AND ownership_share <= 1),
    non_boundary_ownership_share DOUBLE PRECISION NOT NULL CHECK (
        non_boundary_ownership_share >= 0 AND non_boundary_ownership_share <= 1
    ),
    PRIMARY KEY (run_id, organization, repository, file_path, identity_resolution, identity_key)
);
CREATE INDEX IF NOT EXISTS eligible_file_ownership_member_idx
    ON horizon_gt_features.eligible_file_ownership (run_id, authentik_user_pk);

CREATE TABLE IF NOT EXISTS horizon_gt_features.engineering_contribution (
    run_id TEXT NOT NULL,
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    authentik_user_pk TEXT,
    identity_resolution TEXT NOT NULL CHECK (
        identity_resolution IN ('directory_email', 'ambiguous_email', 'unmatched')
    ),
    identity_key TEXT NOT NULL,
    raw_author_identities_json JSONB NOT NULL,
    eligible_source_lines INTEGER NOT NULL CHECK (eligible_source_lines > 0),
    non_boundary_surviving_lines INTEGER NOT NULL CHECK (non_boundary_surviving_lines >= 0),
    log_non_boundary_surviving_lines DOUBLE PRECISION NOT NULL CHECK (log_non_boundary_surviving_lines >= 0),
    eligible_repository_lines INTEGER NOT NULL CHECK (eligible_repository_lines > 0),
    non_boundary_repository_lines INTEGER NOT NULL CHECK (non_boundary_repository_lines >= 0),
    repository_ownership_share DOUBLE PRECISION NOT NULL CHECK (repository_ownership_share >= 0 AND repository_ownership_share <= 1),
    non_boundary_repository_share DOUBLE PRECISION NOT NULL CHECK (non_boundary_repository_share >= 0 AND non_boundary_repository_share <= 1),
    files_owned INTEGER NOT NULL CHECK (files_owned > 0),
    majority_owned_files INTEGER NOT NULL CHECK (majority_owned_files >= 0),
    surviving_commits INTEGER NOT NULL CHECK (surviving_commits >= 0),
    eligible_repository_files INTEGER NOT NULL CHECK (eligible_repository_files > 0),
    PRIMARY KEY (run_id, organization, repository, identity_resolution, identity_key)
);
CREATE INDEX IF NOT EXISTS engineering_contribution_member_idx
    ON horizon_gt_features.engineering_contribution (run_id, authentik_user_pk);

CREATE TABLE IF NOT EXISTS horizon_gt_features.member_pr_review_counts (
    member_id TEXT NOT NULL,
    dagster_run_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviews_written_count INTEGER NOT NULL CHECK (reviews_written_count >= 0),
    approvals_given_count INTEGER NOT NULL CHECK (approvals_given_count >= 0),
    changes_requested_count INTEGER NOT NULL CHECK (changes_requested_count >= 0),
    PRIMARY KEY (member_id, dagster_run_id)
);
CREATE INDEX IF NOT EXISTS member_pr_review_counts_run_idx
    ON horizon_gt_features.member_pr_review_counts (dagster_run_id, member_id);

CREATE TABLE IF NOT EXISTS horizon_gt_features.pr_linked_commit_messages (
    organization TEXT NOT NULL,
    repository TEXT NOT NULL,
    pull_request_number BIGINT NOT NULL CHECK (pull_request_number > 0),
    commit_sha TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    authentik_user_pk TEXT,
    identity_resolution TEXT NOT NULL
        CONSTRAINT pr_linked_commit_identity_resolution_check
        CHECK (identity_resolution IN ('directory_email', 'ambiguous_email', 'unmatched')),
    candidate_count INTEGER NOT NULL
        CONSTRAINT pr_linked_commit_candidate_count_check CHECK (candidate_count >= 0),
    committed_at TIMESTAMPTZ NOT NULL,
    message TEXT NOT NULL,
    dagster_run_id TEXT NOT NULL REFERENCES horizon_gt_features.pipeline_runs(run_id),
    CONSTRAINT pr_linked_commit_messages_run_pkey
        PRIMARY KEY (dagster_run_id, organization, repository, pull_request_number, commit_sha)
);
CREATE INDEX IF NOT EXISTS pr_linked_commit_messages_repository_idx
    ON horizon_gt_features.pr_linked_commit_messages
       (organization, repository, pull_request_number, committed_at DESC);

-- Upgrade databases created by earlier Horizon versions. CREATE TABLE IF NOT
-- EXISTS does not add columns, and the PR-message key used to overwrite runs.
ALTER TABLE horizon_gt_features.git_identity_mapping
    ADD COLUMN IF NOT EXISTS evidence_sources TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS blame_line_count BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS pull_request_commit_count BIGINT NOT NULL DEFAULT 0;

ALTER TABLE horizon_gt_features.pr_linked_commit_messages
    ADD COLUMN IF NOT EXISTS authentik_user_pk TEXT,
    ADD COLUMN IF NOT EXISTS identity_resolution TEXT NOT NULL DEFAULT 'unmatched',
    ADD COLUMN IF NOT EXISTS candidate_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'horizon_gt_features.git_identity_mapping'::regclass
          AND conname = 'git_identity_blame_count_check'
    ) THEN
        ALTER TABLE horizon_gt_features.git_identity_mapping
            ADD CONSTRAINT git_identity_blame_count_check CHECK (blame_line_count >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'horizon_gt_features.git_identity_mapping'::regclass
          AND conname = 'git_identity_pr_count_check'
    ) THEN
        ALTER TABLE horizon_gt_features.git_identity_mapping
            ADD CONSTRAINT git_identity_pr_count_check
            CHECK (pull_request_commit_count >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'horizon_gt_features.pr_linked_commit_messages'::regclass
          AND conname = 'pr_linked_commit_identity_resolution_check'
    ) THEN
        ALTER TABLE horizon_gt_features.pr_linked_commit_messages
            ADD CONSTRAINT pr_linked_commit_identity_resolution_check
            CHECK (identity_resolution IN ('directory_email', 'ambiguous_email', 'unmatched'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'horizon_gt_features.pr_linked_commit_messages'::regclass
          AND conname = 'pr_linked_commit_candidate_count_check'
    ) THEN
        ALTER TABLE horizon_gt_features.pr_linked_commit_messages
            ADD CONSTRAINT pr_linked_commit_candidate_count_check
            CHECK (candidate_count >= 0);
    END IF;
END
$$;

-- Older runs used `running`, which could remain set after Dagster failed. The
-- manifest only claims `complete` after the final write succeeds; all other
-- states are explicitly incomplete.
DO $$
BEGIN
    ALTER TABLE horizon_gt_features.pipeline_runs
        DROP CONSTRAINT IF EXISTS pipeline_runs_status_check;
    ALTER TABLE horizon_gt_features.pipeline_runs
        DROP CONSTRAINT IF EXISTS pipeline_runs_check1;
    UPDATE horizon_gt_features.pipeline_runs
        SET status = 'incomplete' WHERE status = 'running';
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'horizon_gt_features.pipeline_runs'::regclass
          AND conname = 'pipeline_runs_status_allowed_check'
    ) THEN
        ALTER TABLE horizon_gt_features.pipeline_runs
            ADD CONSTRAINT pipeline_runs_status_allowed_check
            CHECK (status IN ('incomplete', 'complete'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'horizon_gt_features.pipeline_runs'::regclass
          AND conname = 'pipeline_runs_completion_check'
    ) THEN
        ALTER TABLE horizon_gt_features.pipeline_runs
            ADD CONSTRAINT pipeline_runs_completion_check
            CHECK ((status = 'incomplete' AND completed_at IS NULL) OR
                   (status = 'complete' AND completed_at IS NOT NULL));
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'horizon_gt_features.pr_linked_commit_messages'::regclass
          AND conname = 'pr_linked_commit_messages_run_pkey'
    ) THEN
        ALTER TABLE horizon_gt_features.pr_linked_commit_messages
            DROP CONSTRAINT IF EXISTS pr_linked_commit_messages_pkey;
        ALTER TABLE horizon_gt_features.pr_linked_commit_messages
            ADD CONSTRAINT pr_linked_commit_messages_run_pkey
            PRIMARY KEY (dagster_run_id, organization, repository, pull_request_number, commit_sha);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS pr_linked_commit_messages_run_idx
    ON horizon_gt_features.pr_linked_commit_messages (dagster_run_id, organization, repository);
CREATE INDEX IF NOT EXISTS pr_linked_commit_messages_member_idx
    ON horizon_gt_features.pr_linked_commit_messages (dagster_run_id, authentik_user_pk)
    WHERE authentik_user_pk IS NOT NULL;
