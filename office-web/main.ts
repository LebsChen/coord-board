import { OfficeFeedConnector, type OfficeFeedSource } from '../office/feed/officeConnector'
import type { OfficeFeed } from '../office/feed/officeFeed'
import { OfficeScene } from '../office/scene/OfficeScene'
import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')!
const params = new URLSearchParams(location.search)
const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))
const projectId = params.get('project')?.trim() ?? ''

app.innerHTML = `
  <section class="shell">
    <header><div><strong>Coord Board Office</strong><span id="project"></span></div><div><span id="connection">Signed out</span><button id="sign-out" class="hidden" type="button">Sign out</button></div></header>
    <div id="loading" class="card"><p>Checking office session…</p></div>
    <div id="auth" class="card hidden">
      <h1>Open a project office</h1>
      <p>Paste a read-only project share token. It is exchanged for a short-lived secure session and is not saved.</p>
      <form id="token-form"><input id="token" type="password" autocomplete="off" placeholder="Read-only share token" required /><button>Open office</button></form>
      <p id="auth-error" class="error"></p>
    </div>
    <div id="office" class="hidden">
      <section class="scene-wrap"><div id="scene"></div></section>
      <aside class="card"><h2>Activity <span id="event-count">0</span></h2><div id="status"></div><ol id="events"></ol></aside>
    </div>
  </section>
`
document.querySelector('#project')!.textContent = projectId ? ` · ${projectId}` : ''

const auth = document.querySelector<HTMLDivElement>('#auth')!
const loading = document.querySelector<HTMLDivElement>('#loading')!
const office = document.querySelector<HTMLDivElement>('#office')!
const status = document.querySelector<HTMLDivElement>('#status')!
const events = document.querySelector<HTMLOListElement>('#events')!
const connection = document.querySelector<HTMLSpanElement>('#connection')!
const sceneHost = document.querySelector<HTMLDivElement>('#scene')!
let connector: OfficeFeedConnector | null = null
let scene: OfficeScene | null = null
const activityLog: string[] = []
const previousStates = new Map<string, string>()

async function exchangeBootstrap(code: string): Promise<boolean> {
  const response = await fetch('/api/board/office/session', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrap: code }),
  })
  return response.ok
}

async function bootstrapWithShareToken(token: string): Promise<boolean> {
  const response = await fetch('/api/board/office/bootstrap', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ project: projectId }),
  })
  if (!response.ok) return false
  const body = await response.json() as { bootstrap?: string }
  return typeof body.bootstrap === 'string' && exchangeBootstrap(body.bootstrap)
}

async function officeFeed(): Promise<OfficeFeed> {
  const query = new URLSearchParams({ project: projectId })
  const response = await fetch(`/api/board/office-actions?${query}`, { credentials: 'include' })
  if (!response.ok) {
    const error = new Error((await response.json() as { error?: string }).error ?? 'Unable to load office') as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return await response.json() as OfficeFeed
}

function renderFeed(feed: OfficeFeed): void {
  const stateByAgent = new Map(feed.states.map((item) => [item.agentId, item]))
  status.textContent = `${feed.roster.length} agents · ${activityLog.length} activity events`
  const names = new Map(feed.roster.map((agent) => [agent.agentId, agent.name]))
  for (const state of feed.states) {
    const signature = `${state.state}:${state.task ?? ''}`
    if (previousStates.get(state.agentId) !== signature) {
      activityLog.unshift(`${names.get(state.agentId) ?? state.agentId}: ${state.state}${state.task ? ` — ${state.task}` : ''}`)
      previousStates.set(state.agentId, signature)
    }
  }
  for (const visit of feed.visits.slice(-10)) {
    if (visit.visitorAgentId === visit.hostAgentId) continue
    const message = `${names.get(visit.visitorAgentId) ?? visit.visitorAgentId} → ${names.get(visit.hostAgentId) ?? visit.hostAgentId}${visit.message ? `: ${visit.message}` : ''}`
    if (!activityLog.includes(message)) activityLog.unshift(message)
  }
  events.innerHTML = activityLog.slice(0, 40).map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')
  document.querySelector('#event-count')!.textContent = String(Math.min(activityLog.length, 40))
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] ?? character))
}

async function openOffice(initialFeed?: OfficeFeed): Promise<void> {
  if (!projectId) throw new Error('A project is required in the URL')
  const feed = initialFeed ?? await officeFeed()
  renderFeed(feed)
  scene = new OfficeScene({
    roster: feed.roster.map((agent) => {
      const state = feed.states.find((item) => item.agentId === agent.agentId)
      return { id: agent.agentId, name: agent.name, role: agent.role, state: state?.state, task: state?.task }
    }),
  })
  await scene.init(sceneHost, sceneHost.clientWidth, sceneHost.clientHeight)
  const source: OfficeFeedSource = {
    getOfficeActions: async (id, since) => {
      const query = new URLSearchParams({ project: id })
      if (since) query.set('since', since)
      const response = await fetch(`/api/board/office-actions?${query}`, { credentials: 'include' })
      if (!response.ok) throw new Error('Office update failed')
      return await response.json() as OfficeFeed
    },
  }
  connector = new OfficeFeedConnector(source, projectId, scene, () => {}, renderFeed)
  await connector.start()
  auth.classList.add('hidden')
  office.classList.remove('hidden')
  connection.textContent = 'Connected'
  document.querySelector<HTMLButtonElement>('#sign-out')!.classList.remove('hidden')
}

async function start(): Promise<void> {
  const bootstrap = fragment.get('bootstrap')
  if (bootstrap) {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
    try {
      if (await exchangeBootstrap(bootstrap)) await openOffice()
      else auth.classList.remove('hidden')
    } catch (reason) {
      document.querySelector<HTMLParagraphElement>('#auth-error')!.textContent =
        reason instanceof Error ? reason.message : 'Unable to open office'
      auth.classList.remove('hidden')
    } finally {
      loading.classList.add('hidden')
    }
    return
  }
  try {
    await openOffice()
  } catch (reason) {
    if ((reason as { status?: number }).status !== 401) {
      document.querySelector<HTMLParagraphElement>('#auth-error')!.textContent =
        reason instanceof Error ? reason.message : 'Unable to load office'
    }
    auth.classList.remove('hidden')
  } finally {
    loading.classList.add('hidden')
  }
}

document.querySelector<HTMLFormElement>('#token-form')!.addEventListener('submit', async (event) => {
  event.preventDefault()
  const error = document.querySelector<HTMLParagraphElement>('#auth-error')!
  error.textContent = ''
  try {
    const token = document.querySelector<HTMLInputElement>('#token')!.value
    if (!(await bootstrapWithShareToken(token))) throw new Error('Invalid, expired, or wrong-project share token')
    await openOffice()
  } catch (reason) {
    error.textContent = reason instanceof Error ? reason.message : 'Unable to open office'
  }
})

document.querySelector<HTMLButtonElement>('#sign-out')!.addEventListener('click', async () => {
  await fetch('/api/board/office/session/revoke', { method: 'POST', credentials: 'include' })
  connector?.stop()
  connector = null
  scene?.destroy()
  scene = null
  sceneHost.replaceChildren()
  office.classList.add('hidden')
  auth.classList.remove('hidden')
  document.querySelector<HTMLButtonElement>('#sign-out')!.classList.add('hidden')
  connection.textContent = 'Signed out'
})

new ResizeObserver(() => {
  if (scene) scene.resize(sceneHost.clientWidth, sceneHost.clientHeight)
}).observe(sceneHost)
void start()
