import { Container, FillGradient, Graphics, Sprite } from 'pixi.js'
import type { Desk } from '../../types/agent'
import { SEAT_OFFSET_Y } from '../layout/officeLayout'
import { getChair, getDesk } from '../assets/officeArt'
import {
  computeChairLayerZ,
  computeDeskLayerZ,
} from '../systems/deskDepthSort'

const STYLE = {
  shadow: { color: 0x000000, alpha: 0.09 },
  deskTop: 0xfdfdfd,
  deskEdge: 0xededee,
  deskStroke: 0xe0e1e3,
  chairDark: 0xbfc2c6,
  chair: 0xe7e8ea,
  chairWheel: 0xb8bbc0,
  monitor: 0x2e3238,
  screenTop: 0x7ec8ff,
  screenBottom: 0x4a8fd9,
  keyboard: 0xeeedea,
  keyboardStroke: 0xd0ccc4,
  mouse: 0xf5f4f1,
} as const

const CHAIR_DEPTH_AHEAD = 2

export class DeskEntity {
  readonly deskId: string
  readonly shadowGfx = new Graphics()
  readonly deskLayer = new Container()
  readonly chairLayer = new Container()
  readonly occupiedIndicator = new Graphics()
  readonly screenAccent = new Graphics()

  private desk: Desk

  constructor(desk: Desk) {
    this.deskId = desk.id
    this.desk = desk

    for (const part of [
      this.shadowGfx,
      this.deskLayer,
      this.chairLayer,
      this.occupiedIndicator,
      this.screenAccent,
    ]) {
      part.position.set(desk.x, desk.y)
    }

    this.drawShadow()
    this.mountSprites()
  }

  updateDepthZ(agentPositions: { x: number; y: number }[]) {
    const nearby = agentPositions.some((agent) =>
      Math.abs(agent.x - this.desk.seatX) < 42 &&
      Math.abs(agent.y - this.desk.seatY) < 32,
    )
    const deskZ = nearby
      ? this.desk.y + 30
      : computeDeskLayerZ(this.desk, agentPositions)
    const chairZ = computeChairLayerZ(
      this.desk,
      agentPositions,
      CHAIR_DEPTH_AHEAD,
    )
    this.deskLayer.zIndex = deskZ
    this.shadowGfx.zIndex = deskZ - 0.5
    this.chairLayer.zIndex = nearby ? this.desk.y + 18 : chairZ
    this.occupiedIndicator.zIndex = chairZ + 0.5
    this.screenAccent.zIndex = this.desk.y + 110
  }

  setOccupied(occupied: boolean) {
    this.occupiedIndicator.clear()
    if (occupied) {
      this.occupiedIndicator.circle(0, SEAT_OFFSET_Y - 4, 5.5)
      this.occupiedIndicator.fill({ color: 0x50b86c, alpha: 0.85 })
      this.occupiedIndicator.stroke({ color: 0xffffff, width: 1.5, alpha: 0.6 })
    }
  }

  setScreenAccent(color?: number, alpha = 0.9) {
    this.screenAccent.clear()
    if (color == null) return
    const width = this.desk.isLeader ? 48 : 44
    const height = this.desk.isLeader ? 25 : 23
    this.screenAccent.roundRect(-width / 2, -45, width, height, 3)
    this.screenAccent.fill({ color, alpha: Math.min(1, alpha) })
  }

  getSeatPosition() {
    return { x: this.desk.seatX, y: this.desk.seatY }
  }

  private mountSprites() {
    if (this.desk.isLeader) return
    const deskTexture = getDesk()
    const chairTexture = getChair()
    if (deskTexture && chairTexture) {
      const desk = new Sprite(deskTexture)
      desk.anchor.set(0.5, 0.68)
      desk.position.set(0, SEAT_OFFSET_Y - 6)
      desk.alpha = 1
      desk.scale.set(145 / deskTexture.width)
      this.deskLayer.addChild(desk)

      const chair = new Sprite(chairTexture)
      chair.anchor.set(0.5, 0.68)
      chair.position.set(0, SEAT_OFFSET_Y + 10)
      chair.alpha = 1
      chair.scale.set(88 / chairTexture.width)
      this.chairLayer.addChild(chair)
    } else {
      this.drawDeskFallback()
      this.drawChairFallback()
    }
  }

  private drawShadow() {
    const g = this.shadowGfx
    g.clear()
    g.ellipse(3, SEAT_OFFSET_Y + 24, 78, 21)
    g.fill({ color: STYLE.shadow.color, alpha: 0.035 })
    g.ellipse(0, SEAT_OFFSET_Y + 19, 58, 14)
    g.fill(STYLE.shadow)
  }

  private drawChairFallback() {
    const g = new Graphics()
    const seatY = 30
    const backTop = 40
    const backBottom = 58
    const baseY = 64

    g.ellipse(0, baseY, 30, 11)
    g.fill(STYLE.chairDark)
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2
      g.circle(Math.cos(a) * 24, baseY + Math.sin(a) * 6, 3.5)
      g.fill(STYLE.chairWheel)
    }
    g.roundRect(-24, backTop, 48, backBottom - backTop, 14)
    g.fill(STYLE.chair)
    g.roundRect(-22, seatY, 44, 14, 8)
    g.fill(STYLE.chair)

    g.position.set(0, SEAT_OFFSET_Y - 36)
    this.chairLayer.addChild(g)
  }

  private drawDeskFallback() {
    const g = new Graphics()

    const width = this.desk.isLeader ? 132 : 98
    const half = width / 2
    g.roundRect(-half, -6, width, 38, 12)
    g.fill(STYLE.deskTop)
    g.stroke({ color: STYLE.deskStroke, width: 1.5, alpha: 0.55 })
    g.roundRect(-half + 3, 29, width - 6, 9, 4)
    g.fill(STYLE.deskEdge)

    const monitorWidth = this.desk.isLeader ? 58 : 46
    const monitorHalf = monitorWidth / 2
    g.roundRect(-monitorHalf, -56, monitorWidth, 34, 6)
    g.fill(STYLE.monitor)

    const screenGrad = new FillGradient({
      type: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: STYLE.screenTop },
        { offset: 1, color: STYLE.screenBottom },
      ],
      textureSpace: 'local',
    })
    g.roundRect(-monitorHalf + 4, -52, monitorWidth - 8, 24, 4)
    g.fill(screenGrad)

    g.roundRect(-20, 0, 40, 8, 4)
    g.fill(STYLE.keyboard)

    g.ellipse(18, 6, 5, 7)
    g.fill(STYLE.mouse)

    this.deskLayer.addChild(g)
  }
}
