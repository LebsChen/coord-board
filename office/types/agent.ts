import type { CharacterFacing } from '../scene/characters/characterFacing'

export type AgentState =
  | 'idle'
  | 'walking'
  | 'working'
  | 'talking'
  | 'thinking'
  | 'blocked'
  | 'done'

export interface DeskVisitStop {
  hostRosterNo: number
  hostAgentId: string
  hostDeskId: string
  message: string
}

/** 工位拜访（可串联多站，最后一站后再回座） */
export interface DeskVisitMission {
  kind: 'desk_visit'
  phase: 'goto' | 'talk' | 'return'
  hostAgentId: string
  hostDeskId: string
  message: string
  resumeTask: string
  resumeState?: AgentState
  talkDuration: number
  talkRemaining?: number
  /** 当前站之后还要去的目标 */
  queue: DeskVisitStop[]
}

export interface Agent {
  id: string
  name: string
  color: number
  x: number
  y: number
  targetX?: number
  targetY?: number
  /** 过道路径点队列（逐段行走） */
  walkPath?: { x: number; y: number }[]
  walkPathIndex?: number
  state: AgentState
  /** Last state/task received from the Board; simulation must not overwrite these. */
  authoritativeState?: AgentState
  authoritativeTask?: string
  currentTask?: string
  assignedDeskId?: string
  bubbleText?: string
  customAnimation?: string
  /** 简笔 fallback 左右翻转 */
  facing: 1 | -1
  /** Four-way character facing, updated from movement. */
  viewFacing?: CharacterFacing
  mission?: DeskVisitMission
  publicZone?: 'coffee' | 'workout' | 'restroom'
  /** Ambient excursion zone retained until the walked return completes. */
  ambientZone?: 'coffee' | 'workout' | 'restroom'
}

export interface Desk {
  id: string
  x: number
  y: number
  seatX: number
  seatY: number
  isLeader?: boolean
  room?: 'leader' | 'open'
  occupiedBy?: string
}
