import { Assets, Rectangle, Texture } from 'pixi.js'
import leaderRoomUrl from '../../art/leader-room-white.webp'
import deskUrl from '../../art/desk-white.webp'
import chairUrl from '../../art/chair-white.webp'
import coffeeUrl from '../../art/amenity-coffee-white.webp'
import workoutUrl from '../../art/amenity-workout-white.webp'
import restroomUrl from '../../art/amenity-restroom-white.webp'
import figureSheetUrl from '../../art/minimal-figure-sheet.webp'

let leaderRoom: Texture | null = null
let desk: Texture | null = null
let chair: Texture | null = null
let amenities: Texture[] = []
let figureFrames: Texture[] = []

export async function loadOfficeArt(): Promise<void> {
  const [room, deskTexture, chairTexture, coffee, workout, restroom, figureSheet] = await Promise.all([
    Assets.load(leaderRoomUrl),
    Assets.load(deskUrl),
    Assets.load(chairUrl),
    Assets.load(coffeeUrl),
    Assets.load(workoutUrl),
    Assets.load(restroomUrl),
    Assets.load(figureSheetUrl),
  ]) as Texture[]
  leaderRoom = room
  desk = deskTexture
  chair = chairTexture
  amenities = [coffee, workout, restroom]
  const frames = (sheet: Texture) => {
    const frameWidth = Math.floor(sheet.width / 4)
    return Array.from({ length: 4 }, (_, index) => new Texture({
      source: sheet.source,
      frame: new Rectangle(index * frameWidth, 0, frameWidth, sheet.height),
    }))
  }
  figureFrames = frames(figureSheet)
}

export function getLeaderRoom(): Texture | null {
  return leaderRoom
}

export function getDesk(): Texture | null {
  return desk
}

export function getChair(): Texture | null {
  return chair
}

export function getAmenity(index: number): Texture | null {
  return amenities[Math.max(0, Math.min(index, amenities.length - 1))] ?? null
}

export function getAgentFrame(index: number): Texture | null {
  return figureFrames[Math.max(0, Math.min(index, figureFrames.length - 1))] ?? null
}

export function isOfficeArtReady(): boolean {
  return leaderRoom != null &&
    desk != null &&
    chair != null &&
    amenities.length === 3 &&
    figureFrames.length === 4
}
