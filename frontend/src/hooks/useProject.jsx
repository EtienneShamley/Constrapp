import { useProjects } from './useProjects'
import { PROJECT_LOAD_STATE, projectLoadState } from '../lib/projects'

// One project out of the company's live projects list.
//
// `project` and `projectLoading` are unchanged for every existing consumer.
// `projectState` (L3 Stage 2) says WHY there is no project: still loading,
// genuinely absent, refused by rules, a failed read, or an unconfirmed cached
// answer. Only the route layout presents it; `retryProject` re-opens a
// listener that ended with an error.
export function useProject(projectId) {
  const {
    projects, projectsLoading, projectsError, projectsErrorCode, projectsFromCache, retryProjects,
  } = useProjects()

  const projectLoading = projectsLoading
  const found = projectLoading
    ? null
    : (projects.find((p) => p.id === projectId) ?? null)

  const projectState = projectLoadState({
    loading: projectLoading,
    error: projectsError,
    errorCode: projectsErrorCode,
    fromCache: projectsFromCache,
    found: found !== null,
  })
  // Never hand out a project unless the state says READY.
  const project = projectState === PROJECT_LOAD_STATE.READY ? found : null

  return { project, projectLoading, projectState, retryProject: retryProjects }
}
