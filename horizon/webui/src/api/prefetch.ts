import { useRef, type PointerEvent } from 'react'

// Query handles request de-duplication. This also avoids dispatching the same
// speculative work for pointerenter, pointerdown and focus in quick succession.
export function usePrefetchThrottle() {
  const last = useRef(new Map<string, number>())
  const lastTouch = useRef(-Infinity)
  return (key: string, work: () => void, event?: PointerEvent) => {
    const now = performance.now()
    if (event?.pointerType === 'touch') {
      lastTouch.current = now
      return
    }
    const connection = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string }
      }
    ).connection
    if (connection?.saveData || connection?.effectiveType?.includes('2g')) return
    if (now - lastTouch.current < 750 || now - (last.current.get(key) ?? -Infinity) < 750) return
    if (last.current.size >= 128) last.current.delete(last.current.keys().next().value!)
    last.current.set(key, now)
    work()
  }
}
