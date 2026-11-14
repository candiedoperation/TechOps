import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

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
  return (
    <section className={`card ${className}`} aria-label={title}>
      <div className="card-heading">
        {Icon && <Icon className="portal-card-icon" size={19} data-tone={tone} aria-hidden="true" />}
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
