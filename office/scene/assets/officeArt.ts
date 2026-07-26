import { Assets, Rectangle, Texture } from 'pixi.js'
import leaderRoomUrl from '../../art/leader-room-front.webp'
import workstationUrl from '../../art/workstation-front.webp'
import coffeeUrl from '../../art/amenity-coffee.webp'
import workoutUrl from '../../art/amenity-workout.webp'
import restroomUrl from '../../art/amenity-restroom.webp'
import workerSheetUrl from '../../art/worker-sheet.webp'
import leaderSheetUrl from '../../art/leader-sheet.webp'

let leaderRoom: Texture | null = null
let workstation: Texture | null = null
let amenities: Texture[] = []
let workerFrames: Texture[] = []
let leaderFrames: Texture[] = []

export async function loadOfficeArt(): Promise<void> {
  const [room, desk, coffee, workout, restroom, workerSheet, leaderSheet] = await Promise.all([
    Assets.load(leaderRoomUrl),
    Assets.load(workstationUrl),
    Assets.load(coffeeUrl),
    Assets.load(workoutUrl),
    Assets.load(restroomUrl),
    Assets.load(workerSheetUrl),
    Assets.load(leaderSheetUrl),
  ]) as Texture[]
  leaderRoom = room
  workstation = desk
  amenities = [coffee, workout, restroom]
  const frames = (sheet: Texture) => {
    const frameWidth = Math.floor(sheet.width / 4)
    return Array.from({ length: 4 }, (_, index) => new Texture({
      source: sheet.source,
      frame: new Rectangle(index * frameWidth, 0, frameWidth, sheet.height),
    }))
  }
  workerFrames = frames(workerSheet)
  leaderFrames = frames(leaderSheet)
}

export function getLeaderRoom(): Texture | null {
  return leaderRoom
}

export function getWorkstation(): Texture | null {
  return workstation
}

export function getAmenity(index: number): Texture | null {
  return amenities[Math.max(0, Math.min(index, amenities.length - 1))] ?? null
}

export function getAgentFrame(index: number, leader = false): Texture | null {
  const frames = leader ? leaderFrames : workerFrames
  return frames[Math.max(0, Math.min(index, frames.length - 1))] ?? null
}

export function isOfficeArtReady(): boolean {
  return leaderRoom != null &&
    workstation != null &&
    amenities.length === 3 &&
    workerFrames.length === 4 &&
    leaderFrames.length === 4
}
