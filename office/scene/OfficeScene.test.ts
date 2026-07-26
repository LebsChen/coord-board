import { describe, expect, it } from 'vitest'
import { OfficeScene } from './OfficeScene'

describe('OfficeScene initial roster state', () => {
  it('preserves state and task on the first paint model', () => {
    const scene = new OfficeScene({
      roster: [
        { id: 'working-agent', name: 'Working', state: 'working', task: 'Ship the fix' },
        { id: 'idle-agent', name: 'Idle', state: 'idle' },
        { id: 'blocked-agent', name: 'Blocked', state: 'blocked', task: 'Needs review' },
      ],
    })

    expect(scene.getAgents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'working-agent', state: 'working', currentTask: 'Ship the fix' }),
      expect.objectContaining({ id: 'idle-agent', state: 'idle' }),
      expect.objectContaining({ id: 'blocked-agent', state: 'blocked', currentTask: 'Needs review' }),
    ]))
  })
})
