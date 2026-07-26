import {
  buildAgentRosterMap,
  convertOfficeState,
  convertOfficeVisits,
  type OfficeFeed,
  type OfficeFeedRosterAgent,
} from './officeFeed'

export interface OfficeFeedSource {
  getOfficeActions(projectId: string, since?: string): Promise<OfficeFeed>
}

export interface OfficeScenePort {
  setAgentState(agentId: string, state: ReturnType<typeof convertOfficeState>['state'], task?: string): void
  requestDeskVisit(visitorRosterNo: number, hostRosterNo: number, message: string): void
}

export function officeStateChanged(
  previous: { state: ReturnType<typeof convertOfficeState>['state']; task?: string } | undefined,
  next: { state: ReturnType<typeof convertOfficeState>['state']; task?: string },
): boolean {
  return previous == null || previous.state !== next.state || previous.task !== next.task
}

export class OfficeFeedConnector {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private cursor = ''
  private rosterMap: Map<string, number> | null = null
  private stateCache = new Map<string, { state: ReturnType<typeof convertOfficeState>['state']; task?: string }>()

  constructor(
    private readonly source: OfficeFeedSource,
    private readonly projectId: string,
    private readonly scene: OfficeScenePort,
    private readonly onRoster: (roster: OfficeFeedRosterAgent[], states: OfficeFeed['states']) => void,
    private readonly onFeed?: (feed: OfficeFeed) => void,
    private readonly intervalMs = 2500,
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    await this.poll()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll()
    }, this.intervalMs)
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    try {
      const initialPoll = this.cursor === ''
      const feed = await this.source.getOfficeActions(this.projectId, this.cursor || undefined)
      if (this.stopped) return
      this.onFeed?.(feed)
      const nextMap = buildAgentRosterMap(feed.roster)
      const rosterChanged =
        !this.rosterMap ||
        JSON.stringify([...nextMap]) !== JSON.stringify([...this.rosterMap])
      if (rosterChanged) {
        if (this.rosterMap) {
          for (const agentId of this.rosterMap.keys()) {
            if (!nextMap.has(agentId)) this.scene.setAgentState(agentId, 'idle')
          }
        }
        this.stateCache.clear()
        this.rosterMap = nextMap
        this.onRoster(feed.roster, feed.states)
      }
      const activeMap = this.rosterMap ?? nextMap
      for (const state of feed.states) {
        const converted = convertOfficeState(state)
        const previous = this.stateCache.get(converted.agentId)
        if (!officeStateChanged(previous, converted)) continue
        this.scene.setAgentState(converted.agentId, converted.state, converted.task)
        this.stateCache.set(converted.agentId, {
          state: converted.state,
          task: converted.task,
        })
      }
      if (!initialPoll) {
        for (const visit of convertOfficeVisits(feed.visits, activeMap)) {
          this.scene.requestDeskVisit(visit.visitor, visit.host, visit.message)
        }
      }
      this.cursor = feed.cursor
    } catch (error) {
      console.warn('[Office] feed poll failed', error)
    } finally {
      this.schedule()
    }
  }
}
