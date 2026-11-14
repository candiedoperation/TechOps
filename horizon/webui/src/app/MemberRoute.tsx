import { lazy } from 'react'
import { loadMember, loadedMember } from './route-loaders'

const LazyMember = lazy(() => loadMember().then((module) => ({ default: module.MemberPage })))
export function MemberRoute() {
  const Page = loadedMember() ?? LazyMember
  return <Page />
}
