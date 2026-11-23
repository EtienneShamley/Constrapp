import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROJECT_LOAD_STATE, projectLoadState } from '../../src/lib/projects'

// ── Project route: unavailable is not "not found" (L3 Stage 2) ───────────────
//
// Three layers: the pure state function; `useProject` and the route layout
// rendered with react-dom/server over a stubbed projects context (no DOM, no
// Firebase); and the provider's wiring as source structure. The real SDK
// behaviour the fix answers to — an unreachable backend delivers an EMPTY list
// flagged fromCache — was measured against the SDK and is recorded in
// TESTING.md §66; a browser going offline is a manual check there.

const S = vi.hoisted(() => ({ ctx: null, retry: null }))

vi.mock('react-router-dom', () => ({
  useParams: () => ({ projectId: 'p1' }),
  NavLink: ({ children }) => children,
  Outlet: () => 'PROJECT-TABS',
}))
vi.mock('../../src/hooks/useProjects', () => ({ useProjects: () => S.ctx }))
vi.mock('../../src/hooks/useCompany', () => ({ useCompany: () => ({ company: { id: 'c1', currency: 'AUD' } }) }))
// M2-A2: the layout filters its tabs and the headline line by role.
vi.mock('../../src/hooks/useProfile', () => ({ useProfile: () => ({ profile: { role: 'company_admin' } }) }))

const { useProject } = await import('../../src/hooks/useProject')
const { default: ProjectDetailLayout } = await import('../../src/layouts/ProjectDetailLayout')

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const project = { id: 'p1', name: 'Harbour Road Units', status: 'In Progress', budget: 0, currency: 'AUD' }
const context = (over = {}) => ({
  projects: [], projectsLoading: false, projectsError: false, projectsErrorCode: null,
  projectsFromCache: false, retryProjects: S.retry, ...over,
})
const render = () => renderToStaticMarkup(h(ProjectDetailLayout))

beforeEach(() => { S.retry = vi.fn(); S.ctx = context() })

describe('projectLoadState', () => {
  const state = (over) => projectLoadState({ loading: false, error: false, errorCode: null, fromCache: false, found: false, ...over })

  it('distinguishes the six facts', () => {
    expect(state({ loading: true })).toBe(PROJECT_LOAD_STATE.LOADING)
    expect(state({ found: true })).toBe(PROJECT_LOAD_STATE.READY)
    expect(state({})).toBe(PROJECT_LOAD_STATE.NOT_FOUND)
    expect(state({ error: true, errorCode: 'permission-denied' })).toBe(PROJECT_LOAD_STATE.PERMISSION_DENIED)
    expect(state({ error: true, errorCode: 'unavailable' })).toBe(PROJECT_LOAD_STATE.UNAVAILABLE)
    expect(state({ fromCache: true })).toBe(PROJECT_LOAD_STATE.OFFLINE)
  })

  it('a failed read is never "not found", whatever the code', () => {
    for (const errorCode of ['unavailable', 'internal', 'resource-exhausted', 'unauthenticated', null, undefined]) {
      expect(state({ error: true, errorCode }), String(errorCode)).toBe(PROJECT_LOAD_STATE.UNAVAILABLE)
    }
  })

  it('loading wins over everything; an error wins over a stale match', () => {
    expect(state({ loading: true, error: true, found: true, fromCache: true })).toBe(PROJECT_LOAD_STATE.LOADING)
    expect(state({ error: true, errorCode: 'permission-denied', found: true })).toBe(PROJECT_LOAD_STATE.PERMISSION_DENIED)
  })

  it('a project already in the cached list is ready; "not found" needs a server answer', () => {
    expect(state({ fromCache: true, found: true })).toBe(PROJECT_LOAD_STATE.READY)
    expect(state({ fromCache: true, found: false })).not.toBe(PROJECT_LOAD_STATE.NOT_FOUND)
  })
})

describe('useProject', () => {
  it('keeps the existing contract when the project is there', () => {
    S.ctx = context({ projects: [project] })
    expect(useProject('p1')).toMatchObject({ project, projectLoading: false, projectState: PROJECT_LOAD_STATE.READY })
  })

  it('loading: no project, still loading', () => {
    S.ctx = context({ projectsLoading: true })
    expect(useProject('p1')).toMatchObject({ project: null, projectLoading: true, projectState: PROJECT_LOAD_STATE.LOADING })
  })

  it('a project in another company is simply not found — nothing is disclosed', () => {
    S.ctx = context({ projects: [{ ...project, id: 'other' }] })
    expect(useProject('p1')).toMatchObject({ project: null, projectState: PROJECT_LOAD_STATE.NOT_FOUND })
  })

  it('a failed read hands out no project and exposes the retry', () => {
    S.ctx = context({ projectsError: true, projectsErrorCode: 'unavailable' })
    const r = useProject('p1')
    expect(r).toMatchObject({ project: null, projectLoading: false, projectState: PROJECT_LOAD_STATE.UNAVAILABLE })
    r.retryProject()
    expect(S.retry).toHaveBeenCalledTimes(1)
  })
})

describe('the route layout presents each state', () => {
  it('ready: the project header and its tabs', () => {
    S.ctx = context({ projects: [project] })
    const html = render()
    expect(html).toContain('Harbour Road Units')
    expect(html).toContain('PROJECT-TABS')
    expect(html).not.toContain('data-project-state')
  })

  it('loading', () => {
    S.ctx = context({ projectsLoading: true })
    expect(render()).toContain('Loading project…')
  })

  it('genuinely missing: "Project not found." and no retry', () => {
    const html = render()
    expect(html).toContain('Project not found.')
    expect(html).toContain('data-project-state="not-found"')
    expect(html).not.toContain('Try again')
    expect(html).not.toContain('PROJECT-TABS')
  })

  it('a failed read is NOT presented as a missing project, and offers a retry', () => {
    S.ctx = context({ projectsError: true, projectsErrorCode: 'unavailable' })
    const html = render()
    expect(html).toContain('data-project-state="unavailable"')
    expect(html).toContain('This project could not be loaded')
    expect(html).toContain('not a missing project')
    expect(html).toContain('Try again')
    expect(html).not.toContain('Project not found')
    expect(html).not.toContain('PROJECT-TABS')
  })

  it('permission denied has its own wording, says who enforces it, and renders no project', () => {
    S.ctx = context({ projectsError: true, projectsErrorCode: 'permission-denied', projects: [] })
    const html = render()
    expect(html).toContain('data-project-state="permission-denied"')
    expect(html).toContain('You do not have access')
    expect(html).toContain('Firestore Security Rules')
    expect(html).not.toContain('Project not found')
    expect(html).not.toContain('Harbour Road Units')
    expect(html).not.toContain('PROJECT-TABS')
  })

  it('an unconfirmed (cached, empty) list waits instead of saying not found', () => {
    S.ctx = context({ projectsFromCache: true })
    const html = render()
    expect(html).toContain('data-project-state="offline"')
    expect(html).toContain('Waiting for the server')
    expect(html).not.toContain('Project not found')
    expect(html).not.toContain('Try again')
  })
})

describe('the projects provider wiring', () => {
  const src = stripComments(read('hooks/useProjects.jsx'))

  it('keeps the error code and the from-cache flag, and asks for metadata changes', () => {
    expect(src).toContain('{ includeMetadataChanges: true }')
    expect(src).toContain('fromCache: querySnap.metadata.fromCache === true')
    expect(src).toContain("readCode: err?.code ?? null")
    // M2-A2: the internal subscription's derivations are prefixed `internal`;
    // the published `projects*` fields select between it and the directory.
    expect(src).toContain('const internalErrorCode = internalError ? snap.readCode : null')
    expect(src).toContain('const internalFromCache = settled && snap.fromCache === true')
    expect(src).toContain('const projectsErrorCode = assigned ? directoryErrorCode : internalErrorCode')
    expect(src).toContain('const projectsFromCache = assigned ? directoryFromCache : internalFromCache')
  })

  it('retry re-opens the listener only after an error, and returns the route to loading', () => {
    expect(src).toContain('}, [internalCompanyId, attempt])')
    expect(src).toMatch(/setSnap\(\(s\) => \(s\.error\s*\? \{ key: null, projects: \[\], error: false, readCode: null, fromCache: false, attempt: s\.attempt \+ 1 \}\s*: s\)\)/)
  })

  it('still reads the same single query: no new read path, no access decision in the client', () => {
    expect(src.match(/onSnapshot\(/g)).toHaveLength(1)
    expect(src).toContain("collection(db, 'companies', internalCompanyId, 'projects')")
    // M2-A2: the query is opened for an internal role only — a selection of
    // which read to issue, never a grant (the rules refuse it to anyone else).
    expect(src).toContain('const internalCompanyId = readsProjectDocuments(role) ? companyId : null')
    expect(src).not.toMatch(/getDocs?\(|collectionGroup\(/)
  })

  it('every existing context field is still published', () => {
    for (const f of ['projects', 'projectsLoading', 'projectsError', 'createProject', 'updateProject', 'updateProjectCurrency', 'lockProjectCurrency']) {
      expect(src).toMatch(new RegExp(`value=\\{\\{[^}]*\\b${f}\\b`))
    }
  })
})
