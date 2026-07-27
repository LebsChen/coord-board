import { describe, expect, it } from 'vitest'
import {
  buildAgentRosterMap,
  convertOfficeState,
  convertOfficeVisits,
} from './officeFeed'

describe('office feed adapter', () => {
  it('keeps server roster order for desk numbers', () => {
    expect(buildAgentRosterMap([
      { agentId: 'a', name: 'A', role: 'worker', status: 'online' },
      { agentId: 'b', name: 'B', role: 'worker', status: 'online' },
    ])).toEqual(new Map([['a', 1], ['b', 2]]))
  })

  it('converts state and task values without changing the feed', () => {
    expect(convertOfficeState({
      agentId: 'a',
      state: 'working',
      task: 'Build the office',
    })).toEqual({
      agentId: 'a',
      state: 'working',
      task: 'Build the office',
    })
  })

  it('drops visits whose agents are not in the current roster', () => {
    const map = new Map([['a', 1], ['b', 2]])
    expect(convertOfficeVisits([
      { visitorAgentId: 'a', hostAgentId: 'b', message: 'sync', at: 'now' },
      { visitorAgentId: 'a', hostAgentId: 'missing', message: 'drop', at: 'now' },
      { visitorAgentId: 'a', hostAgentId: 'a', message: 'self', at: 'now' },
    ], map)).toEqual([{ visitor: 1, host: 2, message: 'sync' }])
  })
})
