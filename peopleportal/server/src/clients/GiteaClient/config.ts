import { GiteaBranchProtection } from "./models";

export const GITEA_DEFAULT_ORG_NAME = "PeoplePortalTeamOwners"
export const GITEA_DEFAULT_BRANCH_NAME = "main"
export const GITEA_DEFAULT_BRANCH_PROTECTION: GiteaBranchProtection = {
    rule_name: GITEA_DEFAULT_BRANCH_NAME,
    priority: 1,

    block_on_official_review_requests: true,
    block_on_rejected_reviews: true,

    enable_approvals_whitelist: true,
    required_approvals: 2,

    block_admin_merge_override: true,
    enable_force_push: false,

    enable_merge_whitelist: true,
    enable_push: true,
    enable_push_whitelist: true,
}