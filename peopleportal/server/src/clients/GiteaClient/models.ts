/**
  People Portal Server
  Copyright (C) 2026  Atheesh Thirumalairajan

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

export interface GiteaAPITeamDefinition {
  id: number,
  name: string,
  description: string,
  organization: string | null,
  includes_all_repositories: boolean,
  permission: "none" | "read" | "write" | "admin" | "owner",
  can_create_org_repo: boolean,
  units: string[],
  units_map: object,
}

export interface GiteaAPIUserDefinition {
  active: boolean;
  avatar_url: string;
  created: string; // ISO date string
  description: string;
  email: string;
  followers_count: number;
  following_count: number;
  full_name: string;
  html_url: string;
  id: number;
  is_admin: boolean;
  language: string;
  last_login: string; // ISO date string
  location: string;
  login: string;
  login_name: string;
  prohibit_login: boolean;
  restricted: boolean;
  source_id: number;
  starred_repos_count: number;
  visibility: string;
  website: string;
}

export interface GiteaUser {
  id: number;
  login: string;
  login_name: string;
  source_id: number;
  full_name: string;
  email: string;
  avatar_url: string;
  html_url: string;
  language: string;
  is_admin: boolean;
  last_login: string;
  created: string;
  restricted: boolean;
  active: boolean;
  prohibit_login: boolean;
  location: string;
  website: string;
  description: string;
  visibility: string;
  followers_count: number;
  following_count: number;
  starred_repos_count: number;
  username: string;
}

export interface GiteaRepositoryPermissions {
  admin: boolean;
  push: boolean;
  pull: boolean;
}

export interface GiteaRepositoryInternalTracker {
  enable_time_tracker: boolean;
  allow_only_contributors_to_track_time: boolean;
  enable_issue_dependencies: boolean;
}

export interface GiteaRepositoryBrief {
  owner: GiteaUser;
  name: string;
}

export interface GiteaRepository extends GiteaRepositoryBrief {
  id: number;
  full_name: string;
  description: string;
  empty: boolean;
  private: boolean;
  fork: boolean;
  template: boolean;
  mirror: boolean;
  size: number;
  language: string;
  languages_url: string;
  html_url: string;
  url: string;
  link: string;
  ssh_url: string;
  clone_url: string;
  original_url: string;
  website: string;
  stars_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  open_pr_counter: number;
  release_counter: number;
  default_branch: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string;
  permissions: GiteaRepositoryPermissions;
  has_issues: boolean;
  internal_tracker: GiteaRepositoryInternalTracker;
  has_wiki: boolean;
  has_pull_requests: boolean;
  has_projects: boolean;
  projects_mode: string;
  has_releases: boolean;
  has_packages: boolean;
  has_actions: boolean;
  ignore_whitespace_conflicts: boolean;
  allow_merge_commits: boolean;
  allow_rebase: boolean;
  allow_rebase_explicit: boolean;
  allow_squash_merge: boolean;
  allow_fast_forward_only_merge: boolean;
  allow_rebase_update: boolean;
  default_delete_branch_after_merge: boolean;
  default_merge_style: string;
  default_allow_maintainer_edit: boolean;
  avatar_url: string;
  internal: boolean;
  mirror_interval: string;
  object_format_name: string;
  mirror_updated: string;
  topics: string[];
  licenses: string[];
}

export interface GiteaHookRepositoryTrigger {
  action: string,
  repository: GiteaRepository,
  organization: GiteaUser,
  sender: GiteaUser,
}

export interface GiteaCommitUser {
  name: string;
  email: string;
  username: string;
}

export interface GiteaCommit {
  id: string;
  message: string;
  url: string;
  author: GiteaCommitUser;
  committer: GiteaCommitUser;
  verification: any;
  timestamp: string;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface GiteaHookCommitTrigger {
  ref: string;
  before: string;
  after: string;
  compare_url: string;
  commits: GiteaCommit[];
  total_commits: number;
  head_commit: GiteaCommit;
  repository: GiteaRepository;
  pusher: GiteaUser;
  sender: GiteaUser;
}

export interface GiteaBranchProtection {
  rule_name: string;
  priority: number;

  approvals_whitelist_teams?: string[];
  approvals_whitelist_username?: string[];
  block_on_official_review_requests?: boolean;
  block_on_rejected_reviews?: boolean;
  dismiss_stale_approvals?: boolean;
  enable_approvals_whitelist?: boolean;
  ignore_stale_approvals?: boolean;
  required_approvals?: number;

  block_admin_merge_override?: boolean;
  block_on_outdated_branch?: boolean;
  enable_force_push?: boolean;
  enable_force_push_allowlist?: boolean;
  enable_merge_whitelist?: boolean;
  enable_push?: boolean;
  enable_push_whitelist?: boolean;

  merge_whitelist_teams?: string[];
  merge_whitelist_usernames?: string[];

  push_whitelist_deploy_keys?: boolean;
  push_whitelist_teams?: string[];
  push_whitelist_usernames?: string[];

  force_push_allowlist_deploy_keys?: boolean;
  force_push_allowlist_teams?: string[];
  force_push_allowlist_usernames?: string[];

  enable_status_check?: boolean;
  status_check_contexts?: string[];
  protected_file_patterns?: string;
  unprotected_file_patterns?: string;
  require_signed_commits?: boolean;
}