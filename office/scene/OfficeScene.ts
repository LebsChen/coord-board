import { Application, Container, Graphics, Sprite, Text } from 'pixi.js'
import type { FederatedPointerEvent } from 'pixi.js'
import type { Agent, AgentState } from '../types/agent'
import {
  AGENT_ROSTER,
  COLORS,
  configureOfficeRoster,
  DESKS,
  pickHandoffVisitMessage,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  PUBLIC_ZONES,
  LEADER_ROOM,
  publicZonePosition,
  selectPublicZone,
} from './layout/officeLayout'
import { AgentEntity } from './entities/AgentEntity'
import { DeskEntity } from './entities/DeskEntity'
import { MovementSystem } from './systems/MovementSystem'
import { AnimationSystem } from './systems/AnimationSystem'
import { OfficeSimulator } from './simulation/OfficeSimulator'
import { applyAgentStateUpdate } from './simulation/deskVisit'
import { LABEL_HEIGHT, LABEL_WIDTH } from './ui/StatusLabel'
import { getRoomPlate, loadOfficeArt } from './assets/officeArt'

export type OfficeAgentClick = {
  agent: Agent
  rosterNo: number
  clientX: number
  clientY: number
}

export class OfficeScene {
  private app: Application | null = null
  private world: Container | null = null
  private agentEntities = new Map<string, AgentEntity>()
  private deskEntities = new Map<string, DeskEntity>()
  private officeLayer: Container | null = null
  private overlayLayer: Container | null = null

  private movement = new MovementSystem()
  private animation = new AnimationSystem()
  private simulator = new OfficeSimulator()
  private activityClock = 0
  private zoneClock = new Map<string, number>()
  private idleVisitSequence = 0

  private agents: Agent[] = []
  private readonly options: {
    onAgentClick?: (event: OfficeAgentClick) => void
    roster?: Array<{
      id: string
      name: string
      role?: string
      state?: AgentState
      task?: string
    }>
  }

  constructor(options: {
    onAgentClick?: (event: OfficeAgentClick) => void
    roster?: Array<{ id: string; name: string; role?: string; state?: AgentState; task?: string }>
  } = {}) {
    this.options = options
    configureOfficeRoster(options.roster ?? [
      { id: "agent-1", name: "Agent 1", role: "" },
    ])
    this.agents = AGENT_ROSTER.map((entry, i) => {
      const desk = DESKS[i]!
      return {
        id: entry.id,
        name: entry.name,
        color: entry.color,
        x: desk.seatX,
        y: desk.seatY,
        state: entry.state ?? 'idle',
        authoritativeState: entry.state ?? 'idle',
        authoritativeTask:
          entry.state === 'working' || entry.state === 'thinking' || entry.state === 'blocked' || entry.state === 'done'
            ? entry.task
            : undefined,
        assignedDeskId: desk.id,
        currentTask:
          entry.state === 'working' || entry.state === 'thinking' || entry.state === 'blocked' || entry.state === 'done'
            ? entry.task
            : undefined,
        facing: i % 2 === 0 ? 1 : -1,
        viewFacing: 'front',
      }
    })
  }

  async init(container: HTMLElement, width: number, height: number) {
    const app = new Application()
    await app.init({
      width,
      height,
      backgroundColor: COLORS.floor,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })

    this.app = app
    container.appendChild(app.canvas)

    this.world = new Container()
    app.stage.addChild(this.world)
    this.fitStage(width, height)

    await loadOfficeArt()
    this.drawMap(this.world)
    this.spawnOffice(this.world)
    this.pushDataToEntities()

    app.ticker.add(this.onTick)
  }

  /** 名册序号从 1 开始：visitor 去找 host 说一句话后回座继续工作 */
  requestDeskVisit(
    visitorRosterNo: number,
    hostRosterNo: number,
    message: string,
  ) {
    this.agents = this.simulator.startDeskVisit(
      this.agents,
      visitorRosterNo,
      hostRosterNo,
      message,
    )
    this.pushDataToEntities()
  }

  /** 按顺序拜访多个工位，全部说完后回访客工位 */
  requestDeskVisitTour(
    visitorRosterNo: number,
    hostRosterNos: number[],
    messageFn?: (hostRosterNo: number, hostName: string) => string,
  ) {
    this.agents = this.simulator.startDeskVisitTour(
      this.agents,
      visitorRosterNo,
      hostRosterNos,
      messageFn ?? ((hostNo, hostName) => pickHandoffVisitMessage(hostName, hostNo)),
    )
    this.pushDataToEntities()
  }

  getAgents(): Agent[] {
    return this.agents.map((agent) => ({ ...agent }))
  }

  setAgentState(id: string, state: AgentState, task?: string) {
    this.agents = this.agents.map((agent) => {
      if (agent.id !== id) return agent
      return applyAgentStateUpdate(agent, state, task)
    })
    this.pushDataToEntities()
  }

  playAgentAnimation(id: string, animation: string, task?: string) {
    this.agents = this.agents.map((agent) => {
      if (agent.id !== id) return agent
      return {
        ...agent,
        state: 'talking' as const,
        currentTask: task,
        targetX: undefined,
        targetY: undefined,
        walkPath: undefined,
        walkPathIndex: undefined,
        mission: undefined,
        bubbleText: undefined,
        customAnimation: animation,
        viewFacing: 'front' as const,
        facing: 1 as const,
      }
    })
    this.pushDataToEntities()
    this.agentEntities.get(id)?.playCustomAnimation(animation, task)
    this.pullDataFromEntities()
  }

  resize(containerWidth: number, containerHeight: number) {
    if (!this.app || !this.world) return
    this.app.renderer.resize(containerWidth, containerHeight)
    this.fitStage(containerWidth, containerHeight)
  }

  /** 按动态工位布局等比缩放并居中，任何屏幕比例下都不裁切内容 */
  private fitStage(containerWidth: number, containerHeight: number) {
    if (!this.world) return

    const padding = 20
    const minX = Math.min(
      ...DESKS.map((desk) => desk.x - LABEL_WIDTH / 2),
      ...PUBLIC_ZONES.map((zone) => zone.x - 62),
      LEADER_ROOM.x,
    ) - padding
    const maxX = Math.max(
      ...DESKS.map((desk) => desk.x + LABEL_WIDTH / 2),
      ...PUBLIC_ZONES.map((zone) => zone.x + 62),
      LEADER_ROOM.x + LEADER_ROOM.width,
    ) + padding
    const minY = Math.min(
      ...DESKS.map((desk) => desk.y - 100 - LABEL_HEIGHT),
      ...PUBLIC_ZONES.map((zone) => zone.y - 38),
      LEADER_ROOM.y,
    ) - padding
    const maxY = Math.max(
      ...DESKS.map((desk) => desk.y + 80),
      ...PUBLIC_ZONES.map((zone) => zone.y + 38),
      LEADER_ROOM.y + LEADER_ROOM.height,
    ) + padding
    const contentWidth = maxX - minX
    const contentHeight = maxY - minY
    const scale = Math.min(
      containerWidth / contentWidth,
      containerHeight / contentHeight,
    )
    const offsetX = (containerWidth - contentWidth * scale) / 2 - minX * scale
    const offsetY = (containerHeight - contentHeight * scale) / 2 - minY * scale

    this.world.scale.set(scale)
    this.world.position.set(offsetX, offsetY)

    const canvas = this.app?.canvas as HTMLCanvasElement | undefined
    if (!canvas) return
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.maxWidth = '100%'
    canvas.style.maxHeight = '100%'
  }

  destroy() {
    this.app?.ticker.remove(this.onTick)
    this.app?.destroy(true, { children: true })
    this.app = null
    this.agentEntities.clear()
    this.deskEntities.clear()
    this.officeLayer = null
    this.overlayLayer = null
  }

  private onTick = (ticker: { deltaTime: number }) => {
    const dt = Math.min(ticker.deltaTime / 60, 0.05)

    this.agents = this.simulator.tick(dt, this.agents)
    this.activityClock += dt
    this.updateIdleActivities()
    this.pushDataToEntities()

    this.movement.update(this.agentEntities, dt)
    this.pullDataFromEntities()

    this.agents = this.simulator.afterMovement(
      dt,
      this.agents,
      this.agentEntities,
    )
    this.pushDataToEntities()

    this.animation.update(this.agentEntities, dt)
    this.sortOfficeDepth()
    this.syncDeskOccupancy()

  }

  private sortOfficeDepth() {
    if (!this.officeLayer) return

    const agentPositions = [...this.agentEntities.values()].map((e) => ({
      x: e.position.x,
      y: e.position.y,
    }))

    for (const e of this.agentEntities.values()) {
      e.zIndex = e.position.y
    }

    for (const desk of this.deskEntities.values()) {
      desk.updateDepthZ(agentPositions)
    }

    this.officeLayer.sortChildren()
  }

  private pushDataToEntities() {
    for (const agent of this.agents) {
      const entity = this.agentEntities.get(agent.id)
      if (!entity) continue

      const prev = entity.data
      entity.apply(agent)
      if (
        prev.x !== agent.x ||
        prev.y !== agent.y ||
        agent.state !== 'walking'
      ) {
        entity.setPosition(agent.x, agent.y)
      }
    }
  }

  private pullDataFromEntities() {
    this.agents = this.agents.map((agent) => {
      const entity = this.agentEntities.get(agent.id)
      return entity ? { ...agent, ...entity.data } : agent
    })
  }

  private syncDeskOccupancy() {
    const occupied = new Set(
      this.agents
        .filter((a) => a.state === 'working' && a.assignedDeskId)
        .map((a) => a.assignedDeskId!),
    )
    for (const desk of this.deskEntities.values()) {
      desk.setOccupied(occupied.has(desk.deskId))
    }
    const screenColors: Record<AgentState, number> = {
      idle: 0xb9bec5,
      walking: 0x92a9bf,
      working: 0x5cbb86,
      thinking: 0x76a7dd,
      blocked: 0xdd7774,
      done: 0x73c895,
      talking: 0xe7aa5d,
    }
    for (const agent of this.agents) {
      if (!agent.assignedDeskId) continue
      const desk = this.deskEntities.get(agent.assignedDeskId)
      if (desk) {
        desk.setScreenAccent(
          agent.state === 'idle' || agent.publicZone
            ? undefined
            : screenColors[agent.state] ?? screenColors.idle,
        )
      }
    }
    for (const desk of this.deskEntities.values()) {
      if (!this.agents.some((agent) => agent.assignedDeskId === desk.deskId)) {
        desk.setScreenAccent(undefined)
      }
    }
  }

  /** 桌子 / 人物 / 椅子同层；桌沿为界动态遮挡 */
  private spawnOffice(parent: Container) {
    const layer = new Container()
    layer.label = 'office'
    layer.sortableChildren = true
    this.officeLayer = layer
    const overlayLayer = new Container()
    overlayLayer.label = 'office-overlays'
    overlayLayer.sortableChildren = true
    this.overlayLayer = overlayLayer

    for (const desk of DESKS) {
      const entity = new DeskEntity(desk)
      this.deskEntities.set(desk.id, entity)
      layer.addChild(
        entity.shadowGfx,
        entity.deskLayer,
        entity.chairLayer,
        entity.occupiedIndicator,
      )
    }

    for (const agent of this.agents) {
      const entity = new AgentEntity(agent)
      this.agentEntities.set(agent.id, entity)
      entity.zIndex = agent.y
      entity.on('pointertap', (event: FederatedPointerEvent) => {
        event.stopPropagation()
        this.options.onAgentClick?.({
          agent: { ...entity.data },
          rosterNo: this.agents.findIndex((a) => a.id === agent.id) + 1,
          clientX: event.clientX,
          clientY: event.clientY,
        })
      })
      layer.addChild(entity)
      overlayLayer.addChild(entity.overlay)
    }

    this.sortOfficeDepth()
    parent.addChild(layer)
    parent.addChild(overlayLayer)
  }

  private drawMap(parent: Container) {
    const map = new Container()
    map.label = 'map'

    const floor = new Graphics()
    floor.rect(0, 0, SCENE_WIDTH, SCENE_HEIGHT)
    floor.fill(COLORS.floor)
    map.addChild(floor)
    const roomPlate = getRoomPlate()
    if (roomPlate) {
      const plate = new Sprite(roomPlate)
      plate.width = SCENE_WIDTH
      plate.height = SCENE_HEIGHT
      map.addChild(plate)
    }
    const roomLabel = new Text({
      text: 'LEADER OFFICE',
      style: { fontFamily: 'system-ui', fontSize: 11, fontWeight: '600', fill: 0x73777e, letterSpacing: 1.5 },
    })
    roomLabel.position.set(LEADER_ROOM.x + 20, LEADER_ROOM.y + 18)
    map.addChild(roomLabel)

    for (const zone of PUBLIC_ZONES) {
      const label = new Text({ text: zone.label, style: { fontFamily: 'system-ui', fontSize: 14, fill: zone.color } })
      label.anchor.set(0.5)
      label.position.set(zone.x, zone.y - 42)
      map.addChild(label)
    }

    parent.addChildAt(map, 0)
  }

  private updateIdleActivities() {
    if (this.activityClock < 6) return
    this.activityClock = 0
    const occupied = new Map<string, number>()
    for (const agent of this.agents) {
      if (agent.publicZone) occupied.set(agent.publicZone, (occupied.get(agent.publicZone) ?? 0) + 1)
    }
    for (const agent of this.agents) {
      if (!agent.publicZone || agent.targetX != null || agent.mission) continue
      const elapsed = (this.zoneClock.get(agent.id) ?? 0) + 6
      this.zoneClock.set(agent.id, elapsed)
      if (elapsed < 18) continue
      const desk = DESKS.find((item) => item.id === agent.assignedDeskId)
      if (desk) {
        this.agents = this.agents.map((item) => item.id === agent.id
          ? {
              ...MovementSystem.assignWalkPath(item, [{ x: desk.seatX, y: desk.seatY }]),
              publicZone: undefined,
            }
          : item)
        this.zoneClock.delete(agent.id)
        this.pushDataToEntities()
      }
    }

    const candidates = this.agents.filter((agent) =>
      (agent.authoritativeState ?? agent.state) === 'idle' &&
      !agent.mission &&
      !agent.publicZone &&
      !agent.targetX,
    )
    const candidate = candidates.length
      ? candidates[this.idleVisitSequence % candidates.length]
      : undefined
    if (!candidate) return
    const selectedZone = selectPublicZone(this.idleVisitSequence, occupied)
    if (!selectedZone) return
    const zone = PUBLIC_ZONES.find((entry) => entry.id === selectedZone.id)!
    const position = publicZonePosition(zone.id, selectedZone.slot)
    this.agents = this.agents.map((item) => item.id === candidate.id
      ? { ...MovementSystem.assignWalkPath(item, [position]), publicZone: zone.id }
      : item)
    this.zoneClock.set(candidate.id, 0)
    this.idleVisitSequence += 1
    this.pushDataToEntities()
  }
}
