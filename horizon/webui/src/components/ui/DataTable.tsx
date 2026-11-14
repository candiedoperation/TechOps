import type { CSSProperties, Key, ReactNode } from 'react'
import { EmptyState } from './States'

export interface TableColumn<T> {
  id: string
  heading: string
  render: (row: T) => ReactNode
  align?: 'left' | 'right'
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  emptyState,
  rowClassName,
  motion = false,
  onRowClick,
}: {
  caption: string
  columns: readonly TableColumn<T>[]
  rows: readonly T[]
  rowKey: (row: T) => Key
  emptyState?: ReactNode
  motion?: boolean
  rowClassName?: (row: T) => string
  onRowClick?: (row: T) => void
}) {
  return (
    <div className="table-region" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                scope="col"
                key={column.id}
                className={column.align === 'right' ? 'text-right' : ''}
              >
                {column.heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, index) => (
              <tr
                key={rowKey(row)}
                data-row-key={motion ? rowKey(row) : undefined}
                style={
                  motion
                    ? ({ '--row-delay': `${Math.min(12, index) * 22}ms` } as CSSProperties)
                    : undefined
                }
                className={rowClassName?.(row)}
                onClick={
                  onRowClick
                    ? (event) => {
                        if (
                          event.target instanceof Element &&
                          event.target.closest('a, button, summary')
                        )
                          return
                        onRowClick(row)
                      }
                    : undefined
                }
              >
                {columns.map((column) => (
                  <td key={column.id} className={column.align === 'right' ? 'text-right' : ''}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length}>
                {emptyState ?? <EmptyState description="No results are available for this view." />}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
