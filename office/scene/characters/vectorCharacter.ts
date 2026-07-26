import { Container, Graphics, Sprite } from 'pixi.js'
import type { AgentState } from '../../types/agent'
import type { CharacterFacing } from './characterFacing'
import { getAgentFrame } from '../assets/officeArt'

export class VectorCharacter extends Container {
  readonly isReady = true
  private readonly shadow: Graphics
  private readonly sprite: Sprite
  private readonly scarf: Graphics
  private color = 0xffffff
  private state: AgentState = 'idle'
  private inZone = false
  private direction: 1 | -1 = 1
  private walkClock = 0

  constructor(_agentId: string, color: number) {
    super()
    this.color = color
    this.shadow = new Graphics()
    this.shadow.ellipse(0, 5, 24, 7)
    this.shadow.fill({ color: 0x000000, alpha: 0.13 })
    this.sprite = new Sprite(getAgentFrame(3) ?? undefined)
    this.scarf = new Graphics()
    this.sprite.anchor.set(0.5, 0.86)
    this.sprite.scale.set(0.18)
    this.addChild(this.shadow, this.sprite, this.scarf)
    this.applyTint()
  }

  setAgentColor(color: number): void {
    this.color = color
    this.applyTint()
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
    return -78
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
    this.applyTint()
  }

  private applyTint(): void {
    this.sprite.tint = 0xffffff
    this.scarf.clear()
    this.scarf.roundRect(-11, -58, 22, 5, 2)
    this.scarf.fill(this.color)
    this.scarf.roundRect(6 * this.direction, -54, 4 * this.direction, 12, 1)
    this.scarf.fill(this.color)
  }
}
