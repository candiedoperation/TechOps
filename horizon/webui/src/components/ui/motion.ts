export const reducedMotionQuery = '(prefers-reduced-motion: reduce)'

export function motionAllowed() {
  return !document.hidden && !window.matchMedia(reducedMotionQuery).matches
}

export function easedValue(value: number, elapsed: number, duration: number) {
  const progress = Math.min(1, Math.max(0, elapsed / duration))
  return value * (1 - (1 - progress) ** 3)
}

export function whenVisible(node: Element, run: () => void) {
  if (!motionAllowed()) return
  if (!('IntersectionObserver' in window)) return
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return
    observer.disconnect()
    if (motionAllowed()) run()
  })
  observer.observe(node)
  return () => observer.disconnect()
}

export function moveFrom(node: HTMLElement, previous: DOMRect) {
  const next = node.getBoundingClientRect()
  const x = previous.left - next.left
  const y = previous.top - next.top
  if ((x || y) && motionAllowed() && node.animate) {
    node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], {
      duration: 280,
      easing: 'cubic-bezier(.22,1,.36,1)',
    })
  }
}
