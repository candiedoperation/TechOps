import type { Key, ReactNode } from 'react'
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
}: {
  caption: string
  columns: readonly TableColumn<T>[]
  rows: readonly T[]
  rowKey: (row: T) => Key
  emptyState?: ReactNode
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
            rows.map((row) => (
              <tr key={rowKey(row)}>
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
