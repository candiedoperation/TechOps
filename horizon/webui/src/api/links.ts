export function externalHttpUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    const link = new URL(value)
    return ['http:', 'https:'].includes(link.protocol) && !link.username && !link.password
      ? link.href
      : null
  } catch {
    return null
  }
}

export function taskAnchor(taskKey: string) {
  return `task-${encodeURIComponent(taskKey)}`
}
