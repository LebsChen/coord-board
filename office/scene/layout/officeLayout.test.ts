import { describe, expect, it } from 'vitest'
import {
  buildDesks,
  PUBLIC_ZONES,
  publicZonePosition,
  selectPublicZone,
} from './officeLayout'

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

  it('distributes idle visits across zones and keeps two occupied slots distinct', () => {
    const empty = new Map()
    expect(selectPublicZone(0, empty)?.id).toBe(PUBLIC_ZONES[0]!.id)
    expect(selectPublicZone(1, empty)?.id).toBe(PUBLIC_ZONES[1]!.id)
    expect(selectPublicZone(2, empty)?.id).toBe(PUBLIC_ZONES[2]!.id)

    const occupancy = new Map([[PUBLIC_ZONES[0]!.id, 1]])
    const selected = selectPublicZone(0, occupancy)!
    expect(selected.id).toBe(PUBLIC_ZONES[0]!.id)
    expect(publicZonePosition(selected.id, selected.slot)).not.toEqual(
      publicZonePosition(selected.id, 0),
    )
  })

  it('returns no zone when every occupancy cap is full', () => {
    const occupancy = new Map(PUBLIC_ZONES.map((zone) => [zone.id, 2] as const))
    expect(selectPublicZone(0, occupancy)).toBeNull()
  })
})
