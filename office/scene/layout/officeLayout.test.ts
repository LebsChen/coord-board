import { describe, expect, it } from 'vitest'
import { buildDesks } from './officeLayout'

describe('office desk layout', () => {
  it('creates exactly one desk per roster agent', () => {
    expect(buildDesks(5)).toHaveLength(5)
    expect(buildDesks(5).map((desk) => desk.id)).toEqual([
      'desk-0',
      'desk-1',
      'desk-2',
      'desk-3',
      'desk-4',
    ])
  })

  it('keeps a usable desk for an empty roster', () => {
    expect(buildDesks(0)).toHaveLength(1)
  })
})
