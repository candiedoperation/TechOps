/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { rankingPublication } from './t62'

describe('T6.2 HTTP alignment without enabling live reads', () => {
  it('keeps draft fields aligned with generated backend models', () => {
    const schema = JSON.parse(readFileSync('../server/openapi.json', 'utf8'))
    expect(Object.keys(schema.components.schemas.Me.properties)).toEqual([
      'userPk',
      'name',
      'isExec',
      'projects',
    ])
    expect(Object.keys(schema.components.schemas.RankingList.properties)).toEqual(
      expect.arrayContaining([
        'rankingRunId',
        'asOf',
        'isFinal',
        'rubricVersion',
        'stale',
        'items',
        'page',
        'pageSize',
        'total',
      ]),
    )
    expect(schema.paths['/api/rankings/members/{userPk}']).toBeDefined()
    expect(schema.components.schemas.MemberRow.properties).toHaveProperty('explanations')
    expect(schema.components.schemas.MemberRow.properties).toHaveProperty('evidence')
  })
  it('uses run age instead of cache age', () => {
    const run = {
      rankingRunId: 'test-run',
      asOf: '2026-10-31T12:00:00Z',
      isFinal: false,
      rubricVersion: 'test-only',
      stale: false,
    }
    expect(rankingPublication(run, Date.parse('2026-11-08T12:00:00Z')).state).toBe('current')
    expect(rankingPublication(run, Date.parse('2026-11-08T12:00:01Z')).state).toBe('stale')
    expect(rankingPublication({ ...run, stale: true }, Date.parse(run.asOf)).state).toBe('stale')
  })
})
