import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { Pagination } from './Pagination'

it('uses backend cursor availability and blocks navigation during a fetch', async () => {
  const onPrevious = vi.fn()
  const onNext = vi.fn()
  const view = render(
    <Pagination hasPrevious={false} hasNext onPrevious={onPrevious} onNext={onNext} />,
  )
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Next' }))
  expect(onNext).toHaveBeenCalledOnce()
  view.rerender(<Pagination hasPrevious hasNext pending onPrevious={onPrevious} onNext={onNext} />)
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
  expect(screen.getByText('Loading results…')).toBeInTheDocument()
})
