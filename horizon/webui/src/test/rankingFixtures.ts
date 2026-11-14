export const currentRun = {
  rankingRunId: '7e6307d2-1489-4223-8519-f67ed9011ca5',
  asOf: '2026-11-10T13:00:00Z',
  isFinal: false,
  rubricVersion: 'v1',
  stale: false,
}

export const finalRun = {
  ...currentRun,
  rankingRunId: '7e6307d2-1489-4223-8519-f67ed9011ca6',
  asOf: '2026-11-08T13:00:00Z',
  isFinal: true,
}

export const ada = {
  userPk: 'member-a',
  name: 'Ada',
  projectPk: 'beacon',
  projectName: 'Beacon',
  role: 'engineer',
  comparisonGroup: 'beacon-group',
  comparisonGroupLabel: 'Project Beacon',
  overallScore: 80,
  coverage: 0.8,
  status: 'ranked',
  rankInGroup: 1,
  rankedInGroup: 5,
  buckets: [{ bucketKey: 'code_ownership', weight: 0.3, score: 72 }],
}
