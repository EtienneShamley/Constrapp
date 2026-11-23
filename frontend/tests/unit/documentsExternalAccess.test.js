import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── External document access follows STATUS (ADR-75 addendum, DC46) ──────────
//
// A non-internal role may read a general document only while it is
// `visibility: 'project'` AND `status: 'active'`. Firestore and Storage Rules
// enforce that (tests/rules/projectDocuments.rules.test.js 61–73,
// tests/rules/storage.rules.test.js 58–69). Rules are not filters, so the
// hook's external query MUST carry both equality filters or it is refused
// outright — these source-structure assertions pin the three places that have
// to agree. (The unit runner has no DOM and no Firestore: structure is what
// can be asserted here, the ADR-26 convention.)

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const squash = (s) => s.replace(/\s+/g, ' ')

const hook = read('src/hooks/useProjectDocuments.jsx')
const page = read('src/pages/project/ProjectGeneralDocuments.jsx')
const firestoreRules = read('firestore.rules')
const transitionalRules = read('firestore.transitional.rules')
const storageRules = read('storage.rules')

describe('useProjectDocuments — the two audiences', () => {
  const flat = squash(hook)

  it('a non-internal role subscribes with BOTH equality filters: visibility == project AND status == active', () => {
    expect(flat).toContain(
      ": query( ref, where('visibility', '==', DOCUMENT_VISIBILITY.PROJECT), where('status', '==', DOCUMENT_STATUS.ACTIVE), )",
    )
  })

  it('an internal role still subscribes to the WHOLE register — history included', () => {
    expect(flat).toContain('const q = seesInternal ? query(ref) :')
  })

  it('no server-side orderBy or range filter is combined with them — so no composite index is needed', () => {
    expect(hook).not.toMatch(/\borderBy\s*\(/)
    expect(hook).not.toMatch(/where\([^)]*'(?:<|<=|>|>=|!=|in|not-in|array-contains|array-contains-any)'/)
    expect(hook.match(/\bwhere\(/g)).toHaveLength(2)
  })
})

describe('ProjectGeneralDocuments — history controls are internal', () => {
  const flat = squash(page)

  it('“Show withdrawn” is rendered only for roles that read the internal register', () => {
    const at = flat.indexOf('Show withdrawn')
    expect(at).toBeGreaterThan(-1)
    expect(flat.match(/Show withdrawn/g)).toHaveLength(1)
    // the label sits directly inside the gated block: gate → <label> → <input> → text
    expect(flat).toMatch(/\{seesInternalDocuments && \( <label className="[^"]*"> <input type="checkbox" checked=\{includeWithdrawn\} onChange=\{[^}]*\} \/> Show withdrawn <\/label> \)\}/)
  })

  it('tells a non-internal reader what is not listed', () => {
    expect(flat).toContain('Internal, superseded and withdrawn documents are not listed.')
  })
})

describe('the rules the query has to satisfy', () => {
  // M2-A2: the non-internal reader must ALSO be assigned to the project.
  const EXTERNAL_READ = "|| (projectReader(companyId, projectId) && resource.data.visibility == 'project' && resource.data.status == 'active');"

  it('firestore.rules: the non-internal read branch requires project visibility AND active status', () => {
    expect(squash(firestoreRules)).toContain(`allow read: if internalMember() ${EXTERNAL_READ}`)
  })

  it('the transitional ruleset carries the same branch', () => {
    expect(squash(transitionalRules)).toContain(`allow read: if internalMember() ${EXTERNAL_READ}`)
  })

  it('storage.rules: the non-internal byte read requires metadata that EXISTS, is project-visible AND active', () => {
    expect(squash(storageRules)).toContain(
      "|| (firestore.exists(metadataRef()) && firestore.get(metadataRef()).data.visibility == 'project' && firestore.get(metadataRef()).data.status == 'active')",
    )
  })

  it('storage.rules: the drawing read is project-scoped since M2-A2 — internal roles, or an assigned client / subcontractor', () => {
    const block = storageRules.slice(storageRules.indexOf('match /companies/{companyId}/projects/{projectId}/drawings/'))
    expect(squash(block)).toContain('allow get: if projectReader(companyId, projectId); allow create:')
  })
})
