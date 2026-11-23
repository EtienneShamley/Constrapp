import { companyRef } from './companyLock.js'

// ── Project assignments — the Firestore half (M2-A2 Stage B, ADR-84) ─────────
//
// `users/{uid}.projectIds` is the ONLY source of a client's or subcontractor's
// project access (ADR-83). The Rules read it on every request; nothing a
// browser sends can write it. This file holds the one question the pure
// checks in validation.js cannot answer: does each project EXIST IN THIS
// COMPANY?
//
// A project lives at `companies/{companyId}/projects/{projectId}`, so the
// company is part of the path that is read. An id that exists only under
// another company is simply absent here — a cross-company assignment cannot
// pass, and it is reported exactly like an id that exists nowhere.

export const projectRef = (db, companyId, projectId) =>
  companyRef(db, companyId).collection('projects').doc(projectId)

// The ids with NO project document in this company. `reader` is a transaction
// (the read then belongs to it: a project removed meanwhile makes the commit
// retry) or the Firestore instance (a dry run).
export async function missingProjects(reader, db, companyId, projectIds) {
  if (projectIds.length === 0) return []
  const snaps = await reader.getAll(...projectIds.map(id => projectRef(db, companyId, id)))
  return projectIds.filter((_, i) => !snaps[i].exists)
}
