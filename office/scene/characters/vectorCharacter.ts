import { Container, Graphics, Sprite } from 'pixi.js'
import type { AgentState } from '../../types/agent'
import type { CharacterFacing } from './characterFacing'
import { getAgentFrame } from '../assets/officeArt'

export class VectorCharacter extends Container {
  readonly isReady = true
  private readonly shadow: Graphics
  private readonly sprite: Sprite
  private readonly identityBand: Graphics
  private state: AgentState = 'idle'
  private inZone = false
  private direction: 1 | -1 = 1
  private walkClock = 0

  constructor(_agentId: string, color: number) {
    super()
    this.shadow = new Graphics()
    this.shadow.ellipse(0, 5, 26, 8)
    this.shadow.fill({ color: 0x000000, alpha: 0.18 })
    this.sprite = new Sprite(getAgentFrame(3) ?? undefined)
    this.sprite.anchor.set(0.5, 0.86)
    this.sprite.scale.set(0.22)
    this.identityBand = new Graphics()
    this.addChild(this.shadow, this.sprite, this.identityBand)
    this.setAgentColor(color)
  }

  setAgentColor(color: number): void {
    this.identityBand.clear()
    this.identityBand.roundRect(-7, -2, 14, 4, 2)
    this.identityBand.fill({ color, alpha: 0.95 })
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
    const texture = getAgentFrame(frame)
    if (texture) this.sprite.texture = texture
    const seated = frame === 3
    const scale = seated ? 0.12 : 0.22
    this.sprite.scale.set(scale * this.direction, scale)
    this.sprite.position.y = seated ? 20 : 0
    this.identityBand.scale.set(1)
    this.identityBand.position.set(0, seated ? -30 : -45)
  }
}
