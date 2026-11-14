export const loadRankings = () => import('../features/rankings/RankingsPage')
let memberPage: typeof import('../features/rankings/MemberPage') | undefined
let memberLoad: Promise<NonNullable<typeof memberPage>> | undefined

export function loadMember() {
  memberLoad ??= import('../features/rankings/MemberPage')
    .then((module) => {
      memberPage = module
      return module
    })
    .catch((error: unknown) => {
      memberLoad = undefined
      throw error
    })
  return memberLoad
}

export function loadedMember() {
  return memberPage?.MemberPage
}
export const loadProjects = () => import('../features/projects/ProjectsListPage')
export const loadProject = () => import('../features/projects/ProjectPages')
