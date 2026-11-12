export function Pagination({
  hasPrevious,
  hasNext,
  pending = false,
  label = 'Results',
  onPrevious,
  onNext,
}: {
  hasPrevious: boolean
  hasNext: boolean
  pending?: boolean
  label?: string
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <nav className="pagination" aria-label="Results pagination">
      <span aria-live="polite">{pending ? 'Loading results…' : label}</span>
      <div className="pagination-actions">
        <button
          className="button button-secondary compact"
          disabled={pending || !hasPrevious}
          onClick={onPrevious}
        >
          Previous
        </button>
        <button
          className="button button-secondary compact"
          disabled={pending || !hasNext}
          onClick={onNext}
        >
          Next
        </button>
      </div>
    </nav>
  )
}
