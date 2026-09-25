-- Postgres schema for the L4 ownership feature assets.
-- These tables are isolated from the legacy application schema.

CREATE SCHEMA IF NOT EXISTS horizon_gt_features;

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
