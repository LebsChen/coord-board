import { describe, expect, it } from 'vitest'
import { OfficeFeedConnector } from './officeConnector'
import type { OfficeFeed } from './officeFeed'

const feed = (cursor: string, visits: OfficeFeed['visits']): OfficeFeed => ({
  roster: [
    { agentId: 'visitor', name: 'Visitor', role: 'worker', status: 'online' },
    { agentId: 'host', name: 'Host', role: 'worker', status: 'online' },
  ],
  states: [
    { agentId: 'visitor', state: 'idle' },
    { agentId: 'host', state: 'working', task: 'Work' },
  ],
  visits,
  cursor,
})

describe('OfficeFeedConnector visit cursor', () => {
  it('adopts the initial cursor without replaying historical visits', async () => {
    const feeds: OfficeFeed[] = [
      feed('initial', [{ visitorAgentId: 'visitor', hostAgentId: 'host', message: 'old', at: 'old' }]),
      feed('next', [{ visitorAgentId: 'visitor', hostAgentId: 'host', message: 'new', at: 'new' }]),
    ]
    const visits: Array<[number, number, string]> = []
    const connector = new OfficeFeedConnector(
      { getOfficeActions: async () => feeds.shift() ?? feed('final', []) },
      'project',
      {
        setAgentState: () => {},
        requestDeskVisit: (visitor, host, message) => visits.push([visitor, host, message]),
      },
      () => {},
      undefined,
      10,
    )

    await connector.start()
    expect(visits).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    connector.stop()
    expect(visits).toEqual([[1, 2, 'new']])
  })
})
