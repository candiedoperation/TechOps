import { useEffect, useRef } from 'react'
import { easedValue, motionAllowed, whenVisible } from './motion'

export function CountUp({ value, animate = true }: { value: number; animate?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const final = String(value)
  useEffect(() => {
    const node = ref.current
    if (!node || !animate) return
    let frame = 0
    const stop = whenVisible(node, () => {
      const start = performance.now()
      const decimals = final.split('.')[1]?.length ?? 0
      const render = (time: number) => {
        if (!motionAllowed() || time - start >= 420) {
          node.textContent = final
          return
        }
        node.textContent = easedValue(value, time - start, 420).toFixed(decimals)
        frame = requestAnimationFrame(render)
      }
      frame = requestAnimationFrame(render)
    })
    return () => {
      stop?.()
      cancelAnimationFrame(frame)
      node.textContent = final
    }
  }, [animate, final, value])
  return (
    <span className="animated-value">
      <span className="sr-only">{final}</span>
      <span aria-hidden="true" ref={ref}>
        {final}
      </span>
    </span>
  )
}
