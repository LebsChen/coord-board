import { describe, expect, it } from 'vitest'
import type { Agent } from '../../types/agent'
import { applyAgentStateUpdate } from './deskVisit'

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
})
