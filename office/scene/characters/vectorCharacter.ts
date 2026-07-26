import { Container, Graphics } from 'pixi.js'
import type { AgentState } from '../../types/agent'
import type { CharacterFacing } from './characterFacing'

export class VectorCharacter extends Container {
  readonly isReady = true
  private readonly body: Graphics
  private readonly shadow: Graphics
  private readonly scarf: Graphics
  private color: number
  private state: AgentState = 'idle'
  private direction: 1 | -1 = 1

  constructor(_agentId: string, color: number) {
    super()
    this.color = color
    this.shadow = new Graphics()
    this.body = new Graphics()
    this.scarf = new Graphics()
    this.addChild(this.shadow, this.body, this.scarf)
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

  playState(state: AgentState, _customAnimation?: string): void {
    this.state = state
    this.redraw()
  }

  playAnimation(_animation: string): void {}

  getHeadOffsetY(): number {
    return -52
  }

  private redraw(): void {
    this.shadow.clear()
    this.shadow.ellipse(0, 4, 24, 7)
    this.shadow.fill({ color: 0x000000, alpha: 0.12 })
    this.body.clear()
    this.scarf.clear()
    const bob = this.state === 'walking' ? 2 : this.state === 'idle' ? 1 : 0
    const legSwing = this.state === 'walking' ? 3 : 0
    this.body.roundRect(-10, 4 + bob + legSwing, 7, 18, 3)
    this.body.roundRect(3, 4 + bob - legSwing, 7, 18, 3)
    this.body.fill(0x202124)
    this.body.roundRect(-15, -10 + bob, 30, 25, 8)
    this.body.fill(0x131313)
    this.body.circle(0, -28 + bob, 17)
    this.body.fill(0x131313)
    for (let i = 0; i < 7; i++) {
      const angle = -Math.PI * 0.95 + i * (Math.PI * 0.9 / 6)
      this.body.moveTo(Math.cos(angle) * 12, -37 + bob + Math.sin(angle) * 10)
      this.body.lineTo(Math.cos(angle) * 20, -45 + bob + Math.sin(angle) * 13)
      this.body.lineTo(Math.cos(angle + 0.22) * 12, -35 + bob + Math.sin(angle + 0.22) * 10)
      this.body.fill(0x131313)
    }
    this.scarf.roundRect(-15, -11 + bob, 30, 5, 2)
    this.scarf.fill(this.color)
    this.scarf.roundRect(7, -7 + bob, 5, 13, 2)
    this.scarf.fill(this.color)
    this.body.scale.x = this.direction
    this.scarf.scale.x = this.direction
  }
}
