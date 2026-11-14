export function readSelection(search: URLSearchParams) {
  const now = new Date()
  const season =
    search.get('season') ?? `${now.getUTCMonth() < 6 ? 'SPRING' : 'FALL'}-${now.getUTCFullYear()}`
  return { season, run: search.get('run') ?? 'current' }
}
