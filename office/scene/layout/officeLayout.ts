import type { Agent, AgentState, Desk } from '../../types/agent'

export const SCENE_WIDTH = 1120
export const SCENE_HEIGHT = 760

export const COLORS = {
  floor: 0xf6f6f7,
  wall: 0xe9eaec,
  desk: 0xfdfdfd,
  deskShadow: 0x00000014,
  monitor: 0x171a1e,
  chair: 0xe1e2e4,
  agentBody: 0x131313,
} as const

/** 动态工位区 */
const DESK_COL_GAP = 240
const DESK_ROW_GAP = 165
export const SEAT_OFFSET_Y = 45
export const LEADER_ROOM = {
  x: 40,
  y: 58,
  width: 300,
  height: 232,
  doorwayX: 340,
  doorwayY: 174,
} as const
export const OPEN_AREA = { x: 320, y: 140, width: 720, height: 420 } as const
export const PUBLIC_ZONES = [
  { id: 'coffee' as const, label: 'Coffee', x: 115, y: 625, color: 0xd99b5f },
  { id: 'workout' as const, label: 'Workout', x: 270, y: 625, color: 0x6eb5a5 },
  { id: 'restroom' as const, label: 'Restroom', x: 425, y: 625, color: 0x8299c7 },
] as const
export type PublicZoneId = typeof PUBLIC_ZONES[number]['id']

const PUBLIC_ZONE_OFFSETS = [
  { x: -24, y: 62 },
  { x: 24, y: 62 },
] as const

export function publicZonePosition(zoneId: PublicZoneId, slot: number): { x: number; y: number } {
  const zone = PUBLIC_ZONES.find((entry) => entry.id === zoneId) ?? PUBLIC_ZONES[0]!
  const offset = PUBLIC_ZONE_OFFSETS[Math.max(0, Math.min(slot, PUBLIC_ZONE_OFFSETS.length - 1))]!
  return { x: zone.x + offset.x, y: zone.y + offset.y }
}

export const PUBLIC_ZONE_CAPACITY = PUBLIC_ZONE_OFFSETS.length

export function selectPublicZone(
  sequence: number,
  occupancy: Map<PublicZoneId, number>,
): { id: PublicZoneId; slot: number } | null {
  for (let offset = 0; offset < PUBLIC_ZONES.length; offset++) {
    const zone = PUBLIC_ZONES[(sequence + offset) % PUBLIC_ZONES.length]!
    const slot = occupancy.get(zone.id) ?? 0
    if (slot < PUBLIC_ZONE_CAPACITY) return { id: zone.id, slot }
  }
  return null
}

export function buildDesks(count: number): Desk[] {
  const total = Math.max(1, count)
  const workerCount = Math.max(0, total - 1)
  const columns = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(workerCount || 1))))
  const rows = Math.max(1, Math.ceil((workerCount || 1) / columns))
  const originX = OPEN_AREA.x + (OPEN_AREA.width - (columns - 1) * DESK_COL_GAP) / 2
  const originY = OPEN_AREA.y + (OPEN_AREA.height - (rows - 1) * DESK_ROW_GAP) / 2
  const desks: Desk[] = []
  desks.push({
    id: 'desk-0',
    x: LEADER_ROOM.x + LEADER_ROOM.width / 2,
    y: LEADER_ROOM.y + LEADER_ROOM.height / 2 + 20,
    seatX: LEADER_ROOM.x + LEADER_ROOM.width / 2,
    seatY: LEADER_ROOM.y + LEADER_ROOM.height / 2 + 52,
    isLeader: true,
    room: 'leader',
  })
  let n = 1
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns && n < total; col++) {
      const x = originX + col * DESK_COL_GAP
      const y = originY + row * DESK_ROW_GAP
      desks.push({
        id: `desk-${n}`,
        x,
        y,
        seatX: x,
        seatY: y + SEAT_OFFSET_Y,
        room: 'open',
      })
      n++
    }
  }
  return desks
}

export const DESKS: Desk[] = buildDesks(1)

export type AgentRosterEntry = {
  id: string
  name: string
  color: number
  task: string
  state?: AgentState
}

/** 默认市场部员工（运行时由 Coord Board 名册替换） */
export const AGENT_ROSTER: AgentRosterEntry[] = [
  {
    id: 'marvis',
    name: '王明',
    color: 0xe85d4a,
    task: '主管：等待交付物',
  },
  {
    id: 'code-agent',
    name: '李研',
    color: 0x4a90d9,
    task: '检索：扫描信息源',
  },
  {
    id: 'file-agent',
    name: '周理',
    color: 0x9b6dd7,
    task: '整理：归类情报',
  },
  {
    id: 'app-agent',
    name: '陈书',
    color: 0xf5c542,
    task: '撰写：起草标书',
  },
  {
    id: 'review-agent',
    name: '刘市',
    color: 0xf97316,
    task: '市场：打包情报简报',
  },
  {
    id: 'data-agent',
    name: '赵审',
    color: 0x4ecdc4,
    task: '审核：合规待审队列',
  },
]

const COLORS_BY_AGENT = [0xe85d4a, 0x4a90d9, 0x9b6dd7, 0xf5c542, 0xf97316, 0x4ecdc4]

function buildInitialAgents(): Agent[] {
  const desks = buildDesks(AGENT_ROSTER.length)
  return AGENT_ROSTER.map((entry, i) => {
    const desk = desks[i]!
    const state = entry.state ?? 'idle'
    return {
      id: entry.id,
      name: entry.name,
      color: entry.color,
      x: desk.seatX,
      y: desk.seatY,
      state,
      authoritativeState: state,
      authoritativeTask: state === 'working' || state === 'thinking' || state === 'blocked' || state === 'done'
        ? entry.task
        : undefined,
      currentTask:
        state === 'working' || state === 'thinking' || state === 'blocked' || state === 'done'
          ? entry.task
          : undefined,
      assignedDeskId: desk.id,
      facing: i % 2 === 0 ? 1 : -1,
      viewFacing: 'front',
    }
  })
}

export const INITIAL_AGENTS: Agent[] = buildInitialAgents()

export function configureOfficeRoster(entries: Array<{
  id: string
  name: string
  role?: string
  state?: AgentState
  task?: string
}>) {
  const normalized = entries.map((entry, index) => ({
    id: entry.id,
    name: entry.name || entry.id,
    color: COLORS_BY_AGENT[index % COLORS_BY_AGENT.length]!,
    task: entry.task ?? entry.role ?? '',
    state: entry.state,
  }))
  AGENT_ROSTER.splice(0, AGENT_ROSTER.length, ...normalized)
  DESKS.splice(0, DESKS.length, ...buildDesks(Math.max(1, normalized.length)))
  INITIAL_AGENTS.splice(0, INITIAL_AGENTS.length, ...buildInitialAgents())
}

/** 交接流程中的状态标签（头顶 / 侧栏） */
export const HANDOFF_STATUS = {
  delivering: '交接递送中…',
  handingOff: '正在交接…',
  receiving: '接收交接中…',
  wrappingUp: '交接收尾中…',
  planning: '规划交接中…',
} as const

/** 离座拜访时交给对方的话术 */
export const HANDOFF_VISIT_MESSAGES: ((hostName: string) => string)[] = [
  (n) => `${n}，这件事交给你了。`,
  (n) => `${n}，轮到你了，说明在工单里。`,
  (n) => `${n}，接力给你，上下文在线程里。`,
  (n) => `${n}，你队列里有最新的交接包。`,
  (n) => `${n}，工单已转给你，我这边解除了阻塞。`,
  (n) => `${n}，能从这里接手吗？`,
  (n) => `${n}，我这边交接完成，交给你了。`,
  (n) => `${n}，收到后请确认一下。`,
]

export function pickHandoffVisitMessage(
  hostName: string,
  hostRosterNo: number,
): string {
  const i = Math.abs(hostRosterNo - 1) % HANDOFF_VISIT_MESSAGES.length
  return HANDOFF_VISIT_MESSAGES[i]!(hostName)
}
