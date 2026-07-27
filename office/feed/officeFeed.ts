import type { AgentState } from '../types/agent'

export type OfficeFeedRosterAgent = {
  agentId: string
  name: string
  role: string
  status: string
}

export type OfficeFeedState = {
  agentId: string
  state: 'working' | 'thinking' | 'blocked' | 'done' | 'idle'
  task?: string
}

export type OfficeFeedVisit = {
  visitorAgentId: string
  hostAgentId: string
  message: string
  at: string
}

export type OfficeFeed = {
  roster: OfficeFeedRosterAgent[]
  states: OfficeFeedState[]
  visits: OfficeFeedVisit[]
  cursor: string
}

export function buildAgentRosterMap(
  roster: OfficeFeedRosterAgent[],
): Map<string, number> {
  return new Map(roster.map((agent, index) => [agent.agentId, index + 1]))
}

export function convertOfficeState(
  state: OfficeFeedState,
): { agentId: string; state: AgentState; task?: string } {
  return {
    agentId: state.agentId,
    state: state.state,
    ...(state.task ? { task: state.task } : {}),
  }
}

export function convertOfficeVisits(
  visits: OfficeFeedVisit[],
  rosterMap: Map<string, number>,
): Array<{ visitor: number; host: number; message: string }> {
  return visits.flatMap((visit) => {
    if (visit.visitorAgentId === visit.hostAgentId) return []
    const visitor = rosterMap.get(visit.visitorAgentId)
    const host = rosterMap.get(visit.hostAgentId)
    return visitor && host && visitor !== host
      ? [{ visitor, host, message: visit.message }]
      : []
  })
}
