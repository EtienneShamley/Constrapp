import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PROJECT_INTERNAL_ROLES, PROJECT_ASSIGNED_ROLES, PROJECT_DIRECTORY_KEYS, PROJECT_EDITABLE_KEYS, ASSIGNED_PROJECTS_MAX,
  readsProjectDocuments, readsAssignedProjects, assignedProjectIds, projectDirectoryFields,
  EMPTY_DIRECTORY_SNAPSHOT, foldDirectoryReport,
} from '../../src/lib/projects.js'
import { PROJECT_TABS, EXTERNAL_PROJECT_TABS, projectTabsFor } from '../../src/lib/projectTabs.js'
import { FINANCIAL_ROLES } from '../../src/lib/margin.js'
import { EXTERNAL_ROLE_VALUES } from '../../src/lib/team.js'
import { navFor } from '../../src/lib/nav.js'
import {
  buildM2a2TransitionalRules, buildTransitionalRules, M2A2_LINE_PAIRS, M2A2_TRANSITIONAL_RULES_PATH, FINAL_RULES_PATH, TRANSITIONAL_RULES_PATH,
} from '../../scripts/build-transitional-rules.mjs'
import { FIRESTORE_RULES_BUDGET_BYTES } from './rulesSize.test.js'

// ── M2-A2 — External Project Isolation: the client half and the artefacts ────
//
// The BOUNDARY is proven against the emulators (tests/rules/
// externalIsolation, projectDirectory, projectDirectoryTransitional). This
// file covers what runs in the browser — which read is opened for which role,
// how the assigned list is assembled, what the paired writes contain — and the
// derived Stage-1 ruleset. Nothing asserted here is a security control.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const squash = (s) => s.replace(/\s+/g, ' ')

describe('which roles read what', () => {
  it('internal = the three financial roles; assigned = client and subcontractor; the sets are disjoint', () => {
    expect([...PROJECT_INTERNAL_ROLES].sort()).toEqual([...FINANCIAL_ROLES].sort())
    expect([...PROJECT_ASSIGNED_ROLES].sort()).toEqual([...EXTERNAL_ROLE_VALUES].sort())
    expect(PROJECT_INTERNAL_ROLES.filter(r => PROJECT_ASSIGNED_ROLES.includes(r))).toEqual([])
  })

  it('every other role — super_admin, an unknown role, no role — reads neither source', () => {
    for (const role of ['super_admin', 'auditor', 'Client', '', null, undefined]) {
      expect(readsProjectDocuments(role)).toBe(false)
      expect(readsAssignedProjects(role)).toBe(false)
    }
  })

  it('the directory keys are exactly the editable display fields', () => {
    expect([...PROJECT_DIRECTORY_KEYS].sort()).toEqual([...PROJECT_EDITABLE_KEYS].sort())
    for (const k of ['budget', 'currency', 'currencyLocked', 'createdBy', 'projectIds']) expect(PROJECT_DIRECTORY_KEYS).not.toContain(k)
  })
})

describe('assignedProjectIds — a missing or malformed assignment is NO assignment', () => {
  const sub = (projectIds) => ({ role: 'subcontractor', projectIds })

  it('returns the well-formed ids, de-duplicated and sorted', () => {
    expect(assignedProjectIds(sub(['pB', 'pA', 'pB']))).toEqual(['pA', 'pB'])
    expect(assignedProjectIds({ role: 'client', projectIds: ['x_1-Y'] })).toEqual(['x_1-Y'])
  })

  it('missing, null, empty and non-list values give []', () => {
    for (const v of [undefined, null, [], 'pA', { pA: true }, 1, true]) expect(assignedProjectIds(sub(v))).toEqual([])
    expect(assignedProjectIds(null)).toEqual([])
    expect(assignedProjectIds(undefined)).toEqual([])
  })

  it('drops entries that are not well-formed document ids (never builds a path from them)', () => {
    expect(assignedProjectIds(sub(['ok', '', 'a/b', '../x', 'has space', 7, null, { id: 'x' }, ['n'], 'y'.repeat(65)]))).toEqual(['ok'])
  })

  it('only an assignable role has an assigned list — an internal or other role never does', () => {
    for (const role of ['company_admin', 'project_manager', 'qs', 'super_admin', 'auditor', undefined]) {
      expect(assignedProjectIds({ role, projectIds: ['pA'] })).toEqual([])
    }
  })

  it('caps the number of listeners', () => {
    const many = Array.from({ length: ASSIGNED_PROJECTS_MAX + 12 }, (_, i) => `p${String(i).padStart(3, '0')}`)
    expect(assignedProjectIds(sub(many))).toHaveLength(ASSIGNED_PROJECTS_MAX)
  })
})

describe('projectDirectoryFields — the entry holds the five fields and nothing else', () => {
  it('takes the five values and drops everything else', () => {
    const startDate = { seconds: 1 }
    const entry = projectDirectoryFields({ name: 'N', status: 'Planning', location: 'L', startDate, progress: 5, budget: 9, currency: 'AUD', currencyLocked: true, createdBy: 'u' })
    expect(Object.keys(entry).sort()).toEqual([...PROJECT_DIRECTORY_KEYS].sort())
    expect(entry.startDate).toBe(startDate)
  })
})

describe('foldDirectoryReport — the assigned list is never shown half-loaded', () => {
  const ids = ['pA', 'pB']
  const ok = (id) => ({ project: { id, name: id }, fromCache: false, code: null })

  it('stays unsettled (key null) until EVERY listener has reported, then lists in id order', () => {
    const one = foldDirectoryReport(EMPTY_DIRECTORY_SNAPSHOT, 'k', ids, 'pB', ok('pB'))
    expect(one.key).toBeNull()
    expect(one.projects).toEqual([])
    const two = foldDirectoryReport(one, 'k', ids, 'pA', ok('pA'))
    expect(two.key).toBe('k')
    expect(two.projects.map(p => p.id)).toEqual(['pA', 'pB'])
    expect(two.error).toBe(false)
  })

  it('an entry that does not exist, or that the rules refuse, is simply absent — not an outage', () => {
    let s = foldDirectoryReport(EMPTY_DIRECTORY_SNAPSHOT, 'k', ids, 'pA', { project: null, fromCache: false, code: null })
    s = foldDirectoryReport(s, 'k', ids, 'pB', { project: null, fromCache: false, code: 'permission-denied' })
    expect(s.key).toBe('k')
    expect(s.projects).toEqual([])
    expect(s.error).toBe(false)
  })

  it('any other failure makes the WHOLE list unavailable — never a list with a silent hole', () => {
    let s = foldDirectoryReport(EMPTY_DIRECTORY_SNAPSHOT, 'k', ids, 'pA', ok('pA'))
    s = foldDirectoryReport(s, 'k', ids, 'pB', { project: null, fromCache: false, code: 'unavailable' })
    expect(s.error).toBe(true)
    expect(s.readCode).toBe('unavailable')
    expect(s.projects).toEqual([])
  })

  it('a later report updates the settled list; from-cache on any entry marks the list unconfirmed', () => {
    let s = foldDirectoryReport(EMPTY_DIRECTORY_SNAPSHOT, 'k', ids, 'pA', ok('pA'))
    s = foldDirectoryReport(s, 'k', ids, 'pB', { ...ok('pB'), fromCache: true })
    expect(s.fromCache).toBe(true)
    s = foldDirectoryReport(s, 'k', ids, 'pB', { project: { id: 'pB', name: 'Renamed' }, fromCache: false, code: null })
    expect(s.fromCache).toBe(false)
    expect(s.projects[1].name).toBe('Renamed')
  })

  it('a new target starts from nothing: the previous target’s reports are not carried over', () => {
    let s = foldDirectoryReport(EMPTY_DIRECTORY_SNAPSHOT, 'k1', ids, 'pA', ok('pA'))
    s = foldDirectoryReport(s, 'k1', ids, 'pB', ok('pB'))
    const next = foldDirectoryReport(s, 'k2', ['pA', 'pC'], 'pA', ok('pA'))
    expect(next.key).toBe('k1')            // still the OLD key, so the hook reports "loading" for k2
    expect(next.pending).toEqual({ key: 'k2', byId: { pA: ok('pA') } })
  })

  it('ignores a report for an id outside the target and preserves the retry counter', () => {
    const start = { ...EMPTY_DIRECTORY_SNAPSHOT, attempt: 3 }
    expect(foldDirectoryReport(start, 'k', ids, 'pZ', ok('pZ'))).toBe(start)
    let s = foldDirectoryReport(start, 'k', ids, 'pA', ok('pA'))
    s = foldDirectoryReport(s, 'k', ids, 'pB', ok('pB'))
    expect(s.attempt).toBe(3)
  })
})

describe('navigation and tabs offered to a non-internal role (UX only)', () => {
  it('internal roles keep every tab; everyone else is offered Overview and Documents', () => {
    for (const role of PROJECT_INTERNAL_ROLES) expect(projectTabsFor(role)).toBe(PROJECT_TABS)
    for (const role of ['subcontractor', 'client', 'super_admin', undefined]) {
      expect(projectTabsFor(role).map(t => t.to)).toEqual(EXTERNAL_PROJECT_TABS)
    }
    expect(EXTERNAL_PROJECT_TABS).toEqual(['overview', 'documents'])
  })

  it('projectTabs.js spells out the same internal roles as lib/projects.js', () => {
    expect(read('src/lib/projectTabs.js')).toContain(`const INTERNAL_TAB_ROLES = [${PROJECT_INTERNAL_ROLES.map(r => `'${r}'`).join(', ')}]`)
  })

  it('an external role is offered Dashboard and Projects only', () => {
    for (const role of PROJECT_ASSIGNED_ROLES) expect(navFor(role).map(n => n.to)).toEqual(['/', '/projects'])
  })

  it('the layout, the overview, the projects page and the dashboard register render no budget for a non-internal role', () => {
    const layout = stripComments(read('src/layouts/ProjectDetailLayout.jsx'))
    expect(layout).toContain('projectTabsFor(profile?.role).map(')
    expect(squash(layout)).toContain('{internal && ( <> {project.budget')
    const overview = stripComments(read('src/pages/project/ProjectOverview.jsx'))
    expect(squash(overview)).toMatch(/\{isFinancialRole\(profile\?\.role\) && \( <Card>[^<]*<p[^>]*>\s*Headline Budget/)
    const projects = stripComments(read('src/pages/Projects.jsx'))
    expect(squash(projects)).toContain('{internal && ( <td')
    expect(projects).toContain("{internal && <Btn onClick={() => setEditing('new')}>+ Add New Project</Btn>}")
    const register = stripComments(read('src/pages/dashboard/ProjectRegister.jsx'))
    expect(register.match(/p\.budget \?/g)).toHaveLength(2)
    expect(register.match(/\{showCommercial && \(/g).length).toBeGreaterThanOrEqual(2)
    expect(stripComments(read('src/pages/Dashboard.jsx'))).toContain('showCommercial={canViewSnapshot}')
  })
})

describe('the provider opens the right read and writes the pair', () => {
  const provider = stripComments(read('src/hooks/useProjects.jsx'))
  const directory = stripComments(read('src/hooks/useProjectDirectory.jsx'))

  it('an assigned role is fed from the directory hook; nothing is subscribed for an unknown role', () => {
    expect(provider).toContain('useProjectDirectory(readsAssignedProjects(role) ? companyId : null, assignedIds)')
    expect(provider).toContain('const internalCompanyId = readsProjectDocuments(role) ? companyId : null')
    expect(provider).toContain('const projects          = assigned ? directory          : internalProjects')
  })

  it('the directory hook reads single DOCUMENTS of projectDirectory — never a collection, never the project', () => {
    expect(directory).toContain("doc(db, 'companies', companyId, 'projectDirectory', id)")
    expect(directory).not.toMatch(/collection\(|query\(|getDocs?\(|'projects'/)
    expect(directory).not.toMatch(/setDoc|updateDoc|writeBatch|addDoc/)
  })

  it('create and edit are ONE batch holding the project and its entry; no unpaired project create remains', () => {
    expect(provider).not.toMatch(/addDoc/)
    expect(provider.match(/writeBatch\(db\)/g)).toHaveLength(2)
    expect(provider).toContain("batch.set(doc(db, 'companies', companyId, 'projectDirectory', ref.id), projectDirectoryFields(fields))")
    expect(provider).toContain("batch.set(doc(db, 'companies', companyId, 'projectDirectory', projectId), projectDirectoryFields(stored))")
    expect(provider.match(/await batch\.commit\(\)/g)).toHaveLength(2)
  })

  it('the currency and lock writes still touch the project alone, and none of the five fields', () => {
    const singles = [...provider.matchAll(/updateDoc\(([^)]*)\), (\{[^}]*\})\)|updateDoc\(ref, (\{[^}]*\})\)/g)].map(m => m[2] ?? m[3])
    expect(singles.length).toBe(3)
    for (const body of singles) for (const k of PROJECT_DIRECTORY_KEYS) expect(body).not.toContain(k)
    const lock = stripComments(read('src/hooks/projectCurrencyLock.js'))
    expect(lock).toContain('tx.update(ref, { currencyLocked: true })')
  })

  it('no other hook writes a project document field that the directory mirrors', () => {
    const company = stripComments(read('src/hooks/useCompany.jsx'))
    expect(company).toContain("batch.update(doc(db, 'companies', companyId, 'projects', projectId), { currency })")
  })

  it('the only server writer of a project document writes currencyLocked alone', () => {
    const transfer = stripComments(read('functions/src/boqBudget/transfer.js'))
    expect(transfer.match(/tx\.(update|set)\(projectRef,/g)).toHaveLength(1)
    expect(transfer).toContain('tx.update(projectRef, { currencyLocked: true }')
    expect(stripComments(read('functions/src/finalAccount/approve.js'))).not.toMatch(/tx\.(update|set)\(projectRef,/)
  })
})

describe('the rules carry the boundary (structure; behaviour is proven in the emulator)', () => {
  const rules = read('firestore.rules')
  const storage = read('storage.rules')

  it('the project document is internal-only and the directory has its own block', () => {
    const block = rules.slice(rules.indexOf('match /companies/{companyId}/projects/{projectId} {'), rules.indexOf('match /companies/{companyId}/projectDirectory/{projectId} {'))
    expect(block).toContain('allow read: if financialMember(companyId);')
    const dir = rules.slice(rules.indexOf('match /companies/{companyId}/projectDirectory/{projectId} {'), rules.indexOf('match /companies/{companyId}/costCodes/'))
    expect(dir).toContain('allow get: if projectReader(companyId, projectId);')
    expect(dir).toContain('allow list: if financialMember(companyId);')
    expect(dir).toContain('allow delete: if false;')
    const keys = `[${PROJECT_DIRECTORY_KEYS.map(k => `'${k}'`).sort().join(', ')}]`
    const listed = [...dir.matchAll(/has(?:Only|All)\(\[([^\]]*)\]\)/g)].map(m => `[${m[1].split(', ').sort().join(', ')}]`)
    expect(listed).toEqual([keys, keys])
  })

  it('drawings, revisions and documents use projectReader in Firestore and in Storage', () => {
    expect(rules.match(/allow read: if projectReader\(companyId, projectId\);/g)).toHaveLength(2)
    expect(rules).toContain("|| (projectReader(companyId, projectId) && resource.data.visibility == 'project' && resource.data.status == 'active');")
    expect(storage.match(/allow get: if projectReader\(companyId, projectId\)/g)).toHaveLength(2)
    expect(storage).not.toMatch(/allow get: if memberOf\(companyId\)/)
  })

  it('projectReader names the two assignable roles and requires a LIST, in both rulesets', () => {
    for (const src of [rules, storage]) {
      expect(src).toContain("['client', 'subcontractor']")
      expect(src).toMatch(/projectIds(?:', null\))? is list/)
    }
  })

  it('users/{uid} stays client-read-only — the assignment cannot be written by any client', () => {
    const users = rules.slice(rules.indexOf('match /users/{uid} {'), rules.indexOf('match /companies/{companyId} {'))
    expect(users).toContain('allow create, update, delete: if false;')
  })
})

describe('the M2-A2 Stage-1 ruleset is derived, and differs in the two pairing lines only', () => {
  const finalSrc = readFileSync(FINAL_RULES_PATH, 'utf8')
  const stage1 = readFileSync(M2A2_TRANSITIONAL_RULES_PATH, 'utf8')

  it('the committed file equals the generated one (run `npm run rules:transitional` after any rules change)', () => {
    expect(stage1).toBe(buildM2a2TransitionalRules(finalSrc))
  })

  it('exactly two marked pairs: project create and project update', () => {
    expect(M2A2_LINE_PAIRS.map(p => p.name)).toEqual(['projects create — the directory pair', 'projects update — the directory pair'])
    for (const pair of M2A2_LINE_PAIRS) {
      expect(finalSrc.split(pair.final).length - 1, pair.name).toBe(1)
      expect(stage1.split(pair.transitional).length - 1, pair.name).toBe(1)
      expect(stage1).not.toContain(pair.final)
      expect(finalSrc).not.toContain(pair.transitional)
    }
    expect(stage1).not.toContain('M2-A2 FINAL')
    expect(finalSrc).not.toContain('M2-A2 TRANSITIONAL')
  })

  it('removing the header and restoring the two lines gives back the FINAL file byte for byte', () => {
    let restored = stage1
    for (const pair of M2A2_LINE_PAIRS) restored = restored.replace(pair.transitional, pair.final)
    const lines = restored.split('\n')
    expect(lines.slice(1, 7).every(l => l.startsWith('//'))).toBe(true)
    expect([lines[0], ...lines.slice(7)].join('\n')).toBe(finalSrc)
  })

  it('Stage 1 keeps the FOUR earlier strict lines strict — it is not the legacy transitional file', () => {
    expect(stage1).toContain('ADR-63 FINAL')
    expect(stage1).toContain('ADR-65 FINAL')
    expect(stage1).toContain('ADR-68 FINAL')
    expect(stage1).not.toContain('ADR-65 TRANSITIONAL')
    expect(read('firebase.m2a2-transitional.json')).toContain('"rules": "firestore.m2a2-transitional.rules"')
  })

  it('the legacy transitional file keeps the M2-A2 pairing strict (it relaxes only its own four lines)', () => {
    const legacy = readFileSync(TRANSITIONAL_RULES_PATH, 'utf8')
    expect(legacy).toBe(buildTransitionalRules(finalSrc))
    for (const pair of M2A2_LINE_PAIRS) expect(legacy).toContain(pair.final)
  })

  it('Stage 1 keeps the whole read boundary and the directory block', () => {
    for (const fragment of [
      'allow read: if financialMember(companyId);\n\n      allow create: if request.auth != null',
      'allow get: if projectReader(companyId, projectId);',
      'function mirrorsProject() {',
      'function projectReader(companyId, projectId) {',
    ]) expect(stage1).toContain(fragment)
  })

  it('every ruleset is under the size budget', () => {
    for (const src of [finalSrc, stage1]) expect(Buffer.byteLength(src, 'utf8')).toBeLessThan(FIRESTORE_RULES_BUDGET_BYTES)
  })
})

// ── Document-access budget of the pairing ───────────────────────────────────
//
// Firestore allows 10 exists() / get() / getAfter() calls per operation and 20
// per batched write or transaction; exceeding either is a permission-denied.
// Repeated calls for the SAME document may be cached, but the documentation
// does not promise it — so this counts EVERY call in the source, the worst
// case, and holds the app's one-pair commit under both limits. (The emulator
// enforces 10 per operation on DISTINCT documents and does not enforce the
// batch limit at all, so an emulator pass is not evidence for the limit.)
describe('the paired write stays inside the Firestore access-call limits, counting every call', () => {
  const rules = read('firestore.rules')
  const PER_OPERATION = 10
  const PER_COMMIT = 20
  const calls = (src) => (src.match(/\b(?:get|exists|getAfter|existsAfter)\(\//g) ?? []).length + (src.match(/\b(?:getAfter|existsAfter)\((?:directoryPath|projectPath)\(/g) ?? []).length
  const body = (name, from = 0) => {
    const start = rules.indexOf(`function ${name}(`, from)
    expect(start, name).toBeGreaterThan(-1)
    return rules.slice(start, rules.indexOf('\n      }', start) === -1 ? undefined : rules.indexOf('}\n', start))
  }

  const sameCompany = calls(body('sameCompany'))          // exists + get
  const memberRole = calls(body('memberRole'))            // get
  const directoryPaired = calls(body('directoryPaired'))  // existsAfter + 5 getAfter
  const source = calls(body('source'))                    // getAfter
  const mirrors = body('mirrorsProject')
  const mirrorsProject = calls(mirrors) + (mirrors.match(/source\(\)/g) ?? []).length * source

  it('the helper call counts are what the analysis assumes', () => {
    expect({ sameCompany, memberRole, directoryPaired, source, mirrorsProject }).toEqual({
      sameCompany: 2, memberRole: 1, directoryPaired: 6, source: 1, mirrorsProject: 6,
    })
  })

  // The project create / update rules read the profile twice inline (companyId, role).
  const projectWrite = 2 + directoryPaired
  const directoryWrite = sameCompany + memberRole + mirrorsProject

  it(`a project create or display edit spends ${projectWrite} calls; its directory entry ${directoryWrite} — each within ${PER_OPERATION}`, () => {
    const block = rules.slice(rules.indexOf('match /companies/{companyId}/projects/{projectId} {'), rules.indexOf('match /companies/{companyId}/projectDirectory/{projectId} {'))
    const create = block.slice(block.indexOf('allow create:'), block.indexOf('allow update:'))
    expect(calls(create)).toBe(2)
    const updateA = block.slice(block.indexOf('allow update:'), block.indexOf('// (b) QS currency-lock ratchet ONLY'))
    expect(calls(updateA)).toBe(2)
    expect(projectWrite).toBe(8)
    expect(directoryWrite).toBe(9)
    expect(projectWrite).toBeLessThanOrEqual(PER_OPERATION)
    expect(directoryWrite).toBeLessThanOrEqual(PER_OPERATION)
  })

  it(`ONE pair — the only shape the app commits — spends ${projectWrite + directoryWrite} of the ${PER_COMMIT} per commit; a second pair would not fit`, () => {
    expect(projectWrite + directoryWrite).toBeLessThanOrEqual(PER_COMMIT)
    expect(2 * (projectWrite + directoryWrite)).toBeGreaterThan(PER_COMMIT)
    // …and the app never puts two pairs, or a pair plus another rules-checked
    // write, in one commit: each batch holds exactly the project and its entry.
    const provider = stripComments(read('src/hooks/useProjects.jsx'))
    expect(provider.match(/batch\.(set|update|delete)\(/g)).toHaveLength(4)
    expect(provider.match(/writeBatch\(db\)/g)).toHaveLength(2)
  })

  it('an external read spends at most 9 calls (a project document: internalMember, then projectReader)', () => {
    const projectReader = body('projectReader')
    const reader = calls(projectReader) + (projectReader.match(/sameCompany\(/g) ?? []).length * sameCompany + (projectReader.match(/memberRole\(\)/g) ?? []).length * memberRole
    expect(reader).toBe(6)
    const internalMember = sameCompany + 1
    expect(internalMember + reader).toBeLessThanOrEqual(PER_OPERATION)
  })

  it('a write that changes no display field evaluates no pairing call (the test precedes the pairing and short-circuits)', () => {
    expect(rules).toContain("&& (!changedKeys().hasAny(['name', 'status', 'location', 'startDate', 'progress']) || directoryPaired())")
  })
})
