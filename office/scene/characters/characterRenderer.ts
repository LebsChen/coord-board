import { Container, Graphics } from 'pixi.js'
import type { AgentState } from '../../types/agent'
import type { CharacterFacing } from './characterFacing'

export interface CharacterRenderer extends Container {
  readonly isReady: boolean
  setAgentColor(color: number): void
  setFacing(direction: 1 | -1): void
  setViewFacing(facing: CharacterFacing): void
  playState(state: AgentState, customAnimation?: string): void
  playAnimation(animation: string): void
  getHeadOffsetY(): number
}

export type CharacterRendererFactory = (
  agentId: string,
  color: number,
) => CharacterRenderer

/** Small self-contained renderer used by Board and other hosts by default. */
export class VectorCharacter extends Container implements CharacterRenderer {
  readonly isReady = true
  private readonly body: Graphics
  private readonly shadow: Graphics
  private color: number
  private direction: 1 | -1 = 1

  constructor(_agentId: string, color: number) {
    super()
    this.color = color
    this.shadow = new Graphics()
    this.body = new Graphics()
    this.addChild(this.shadow, this.body)
    this.redraw()
  }

  setAgentColor(color: number): void {
    this.color = color
    this.redraw()
  }

  setFacing(direction: 1 | -1): void {
    this.direction = direction
    this.scale.x = direction
  }

  setViewFacing(_facing: CharacterFacing): void {}

  playState(_state: AgentState, _customAnimation?: string): void {}

  playAnimation(_animation: string): void {}

  getHeadOffsetY(): number {
    return -52
  }

  private redraw(): void {
    this.shadow.clear()
    this.shadow.ellipse(0, 4, 24, 7)
    this.shadow.fill({ color: 0x000000, alpha: 0.12 })
    this.body.clear()
    this.body.circle(0, -20, 14)
    this.body.fill(this.color)
    this.body.roundRect(-14, -8, 28, 25, 8)
    this.body.fill(this.color)
    this.body.scale.x = this.direction
  }
}

export const defaultCharacterRenderer: CharacterRendererFactory = (
  agentId,
  color,
) => new VectorCharacter(agentId, color)
