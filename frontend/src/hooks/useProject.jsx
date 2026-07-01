import { useProjects } from './useProjects'

export function useProject(projectId) {
  const { projects, projectsLoading } = useProjects()

  const projectLoading = projectsLoading
  const project = projectLoading
    ? null
    : (projects.find((p) => p.id === projectId) ?? null)

  return { project, projectLoading }
}
