const missingReasons: Record<string, string> = {
  no_review_requests: 'No review requests were available in this semester.',
  no_reviews: 'No eligible code reviews were recorded.',
  no_commits: 'No eligible commits were recorded.',
  no_pull_requests: 'No eligible pull requests were recorded.',
  no_sow: 'The project has no published statement of work.',
  no_due_tasks: 'No tasks were due in this reporting period.',
  no_peer_ratings: 'No eligible peer ratings were recorded.',
  no_ratings: 'No eligible ratings were recorded.',
  missing_roster: 'Semester membership data was unavailable.',
}

export function explainMissing(reason: string) {
  return (
    missingReasons[reason] ??
    (reason.includes('_') ? `Unavailable (${reason.replaceAll('_', ' ')}).` : reason)
  )
}
