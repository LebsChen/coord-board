import { describe, expect, it } from 'vitest'
import type { Agent } from '../../types/agent'
import { applyAgentStateUpdate } from './deskVisit'
import { startDeskVisit } from './deskVisit'
import { configureOfficeRoster, DESKS } from '../layout/officeLayout'

const agent: Agent = {
  id: 'visitor',
  name: 'Visitor',
  color: 0,
  x: 10,
  y: 10,
  state: 'walking',
  currentTask: '交接递送中…',
  facing: 1,
  walkPath: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
  walkPathIndex: 0,
  targetX: 20,
  targetY: 20,
  mission: {
    kind: 'desk_visit',
    phase: 'goto',
    hostAgentId: 'host',
    hostDeskId: 'desk-1',
    message: '同步一下',
    resumeTask: '原任务',
    resumeState: 'working',
    talkDuration: 3.5,
    queue: [],
  },
}

describe('desk visit state updates', () => {
  it('keeps an active mission and applies the latest state when it settles', () => {
    const updated = applyAgentStateUpdate(agent, 'idle')

    expect(updated.state).toBe('walking')
    expect(updated.targetX).toBe(20)
    expect(updated.mission).toMatchObject({
      phase: 'goto',
      resumeState: 'idle',
      resumeTask: '',
    })
  })

  it('keeps a changed working task for the end of the mission', () => {
    const updated = applyAgentStateUpdate(agent, 'working', '新任务')

    expect(updated.mission?.resumeState).toBe('working')
    expect(updated.mission?.resumeTask).toBe('新任务')
    expect(updated.walkPath).toHaveLength(2)
  })

  it('preempts an idle zone excursion with the visit mission path', () => {
    configureOfficeRoster([
      { id: 'visitor', name: 'Visitor', state: 'idle' },
      { id: 'host', name: 'Host', state: 'working', task: 'Host task' },
    ])
    const visitorDesk = DESKS[0]!
    const hostDesk = DESKS[1]!
    const agents: Agent[] = [
      {
        ...agent,
        id: 'visitor',
        state: 'walking',
        authoritativeState: 'idle',
        authoritativeTask: undefined,
        currentTask: undefined,
        assignedDeskId: visitorDesk.id,
        targetX: 120,
        targetY: 120,
        publicZone: 'coffee',
        mission: undefined,
      },
      {
        ...agent,
        id: 'host',
        name: 'Host',
        x: 300,
        y: 300,
        assignedDeskId: hostDesk.id,
        state: 'working',
        authoritativeState: 'working',
        authoritativeTask: 'Host task',
        currentTask: 'Host task',
      },
    ]

    const next = startDeskVisit(agents, 1, 2, 'Visit host')
    expect(next[0]).toMatchObject({
      mission: { kind: 'desk_visit', hostAgentId: 'host' },
      state: 'walking',
      publicZone: undefined,
    })
    expect(next[0]!.targetX).not.toBe(120)
  })
})
