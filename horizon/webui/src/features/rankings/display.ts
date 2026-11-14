export const rankingStatus = {
  ranked: { label: 'Ranked', reason: 'The member has a published rank.' },
  unranked: { label: 'Unranked', reason: 'No rank was published for this member.' },
  insufficient_data: {
    label: 'Insufficient data',
    reason: 'Too little evidence was available to publish a score.',
  },
  group_too_small: {
    label: 'Group too small',
    reason: 'Too few members qualified for a comparison.',
  },
}
