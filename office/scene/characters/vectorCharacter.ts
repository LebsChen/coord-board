import { Container, Graphics, Sprite } from 'pixi.js'
import type { AgentState } from '../../types/agent'
import type { CharacterFacing } from './characterFacing'
import { getAgentFrame } from '../assets/officeArt'

export class VectorCharacter extends Container {
  readonly isReady = true
  private readonly shadow: Graphics
  private readonly sprite: Sprite
  private readonly leader: boolean
  private state: AgentState = 'idle'
  private inZone = false
  private direction: 1 | -1 = 1
  private walkClock = 0

  constructor(_agentId: string, color: number, leader = false) {
    super()
    this.leader = leader
    this.shadow = new Graphics()
    this.shadow.ellipse(0, 5, 24, 7)
    this.shadow.fill({ color: 0x000000, alpha: 0.13 })
    this.sprite = new Sprite(getAgentFrame(3, leader) ?? undefined)
    this.sprite.anchor.set(0.5, 0.86)
    this.sprite.scale.set(0.22)
    this.addChild(this.shadow, this.sprite)
  }

  setAgentColor(color: number): void {
    void color
  }

  setFacing(direction: 1 | -1): void {
    this.direction = direction
    this.sprite.scale.x = Math.abs(this.sprite.scale.x) * direction
  }

  setViewFacing(_facing: CharacterFacing): void {}

  setInZone(inZone: boolean): void {
    this.inZone = inZone
    this.updateFrame()
  }

  playState(state: AgentState, _customAnimation?: string): void {
    this.state = state
    if (state === 'walking') this.walkClock += 1 / 12
    this.updateFrame()
  }

  playAnimation(_animation: string): void {}

  getHeadOffsetY(): number {
    return -82
  }

  private updateFrame(): void {
    const frame =
      this.state === 'walking'
        ? 1 + (Math.floor(this.walkClock * 8) % 2)
        : this.inZone
          ? 0
          : 3
    const texture = getAgentFrame(frame, this.leader)
    if (texture) this.sprite.texture = texture
    const seated = frame === 3
    const scale = seated ? (this.leader ? 0.2 : 0.16) : 0.22
    this.sprite.scale.set(scale * this.direction, scale)
    this.sprite.position.y = seated ? 4 : 0
  }
}
