import { describe, expect, it } from 'vitest'
import type { Agent } from '../../types/agent'
import { OfficeSimulator } from './OfficeSimulator'

const makeAgent = (overrides: Partial<Agent>): Agent => ({
  id: 'agent',
  name: 'Agent',
  color: 0,
  x: 100,
  y: 100,
  assignedDeskId: 'desk-0',
  state: 'working',
  authoritativeState: 'working',
  authoritativeTask: 'Authoritative task',
  currentTask: 'Authoritative task',
  facing: 1,
  ...overrides,
})

describe('Office ambient simulation', () => {
  it('never rewrites authoritative state or task', () => {
    const simulator = new OfficeSimulator()
    const [blocked] = simulator.tick(0.1, [makeAgent({
      state: 'blocked',
      authoritativeState: 'blocked',
      authoritativeTask: 'Needs review',
      currentTask: 'Needs review',
    })])
    expect(blocked).toMatchObject({
      state: 'blocked',
      authoritativeState: 'blocked',
      currentTask: 'Needs review',
    })

    const [idle] = simulator.tick(0.1, [makeAgent({
      state: 'idle',
      authoritativeState: 'idle',
      authoritativeTask: undefined,
      currentTask: undefined,
    })])
    expect(idle.state).toBe('idle')
  })

  it('preserves an ambient walk when a visit mission has not started yet', () => {
    const simulator = new OfficeSimulator()
    const agent = makeAgent({
      state: 'walking',
      authoritativeState: 'idle',
      targetX: 140,
      targetY: 120,
      publicZone: 'coffee',
    })
    expect(simulator.tick(0.1, [agent])[0]).toMatchObject({
      state: 'walking',
      targetX: 140,
      targetY: 120,
      publicZone: 'coffee',
    })
  })

  it('does not pin a dwelling idle agent back to its desk', () => {
    const simulator = new OfficeSimulator()
    const agent = makeAgent({
      state: 'idle',
      authoritativeState: 'idle',
      x: 91,
      y: 687,
      publicZone: 'coffee',
    })
    expect(simulator.tick(0.1, [agent])[0]).toMatchObject({
      x: 91,
      y: 687,
      state: 'idle',
      publicZone: 'coffee',
    })
  })
})
