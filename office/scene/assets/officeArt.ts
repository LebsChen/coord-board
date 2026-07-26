import { Assets, Rectangle, Texture } from 'pixi.js'
import roomPlateUrl from '../../art/room-plate.webp'
import workstationUrl from '../../art/workstation.webp'
import agentSheetUrl from '../../art/agent-sheet.webp'

let roomPlate: Texture | null = null
let workstation: Texture | null = null
let agentSheet: Texture | null = null
let agentFrames: Texture[] = []

export async function loadOfficeArt(): Promise<void> {
  const [room, desk, sheet] = await Promise.all([
    Assets.load(roomPlateUrl),
    Assets.load(workstationUrl),
    Assets.load(agentSheetUrl),
  ]) as Texture[]
  roomPlate = room
  workstation = desk
  agentSheet = sheet
  const frameWidth = Math.floor(sheet.width / 4)
  agentFrames = Array.from({ length: 4 }, (_, index) => new Texture({
    source: sheet.source,
    frame: new Rectangle(index * frameWidth, 0, frameWidth, sheet.height),
  }))
}

export function getRoomPlate(): Texture | null {
  return roomPlate
}

export function getWorkstation(): Texture | null {
  return workstation
}

export function getAgentFrame(index: number): Texture | null {
  return agentFrames[Math.max(0, Math.min(index, agentFrames.length - 1))] ?? null
}

export function isOfficeArtReady(): boolean {
  return roomPlate != null && workstation != null && agentSheet != null && agentFrames.length === 4
}
