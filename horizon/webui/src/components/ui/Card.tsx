import { useEffect, useRef, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { motionAllowed } from './motion'

export function Card({
  title,
  description,
  action,
  icon: Icon,
  tone = 'blue',
  children,
  className = '',
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: LucideIcon
  tone?: 'blue' | 'green' | 'amber'
  children: ReactNode
  className?: string
}) {
  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  return (
    <section
      className={`card ${className}`}
      aria-label={title}
      onPointerMove={
        Icon
          ? (event) => {
              if (event.pointerType !== 'mouse' || !motionAllowed()) return
              const { currentTarget: node, clientX, clientY } = event
              cancelAnimationFrame(frame.current)
              frame.current = requestAnimationFrame(() => {
                const bounds = node.getBoundingClientRect()
                node.style.setProperty('--spot-x', `${clientX - bounds.left}px`)
                node.style.setProperty('--spot-y', `${clientY - bounds.top}px`)
              })
            }
          : undefined
      }
      onPointerLeave={Icon ? () => cancelAnimationFrame(frame.current) : undefined}
    >
      <div className="card-heading">
        {Icon && (
          <Icon className="portal-card-icon" size={19} data-tone={tone} aria-hidden="true" />
        )}
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {Icon ? <div className="portal-card-body">{children}</div> : children}
    </section>
  )
}
