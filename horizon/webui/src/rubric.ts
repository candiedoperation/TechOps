import type { RankingRole } from './api/contracts/rankings'

// Bucket labels and shares from the pilot Track 4 rubric v1 proposal.
export const rubricV1: Record<RankingRole, Record<string, { label: string; weight: number }>> = {
  engineer: {
    code_ownership: { label: 'Code ownership', weight: 30 },
    delivery: { label: 'Delivery against the SOW', weight: 20 },
    consistency: { label: 'Consistency', weight: 15 },
    review_collaboration: { label: 'Review and collaboration', weight: 15 },
    peer_ratings: { label: 'Tech lead ratings', weight: 10 },
    club_engagement: { label: 'Club engagement', weight: 10 },
  },
  tech_lead: {
    team_delivery: { label: 'Team delivery against the SOW', weight: 30 },
    review_unblocking: { label: 'Review and unblocking', weight: 25 },
    leadership_ratings: { label: 'Leadership ratings', weight: 25 },
    team_consistency: { label: 'Team consistency', weight: 10 },
    own_code: { label: 'Own code', weight: 5 },
    club_engagement: { label: 'Club engagement', weight: 5 },
  },
}
