/** Values and bounds must be supplied by a reviewed rubric, never inferred from missing data. */
export function ScoreBar({
  value,
  maximum,
  label,
}: {
  value: number | null
  maximum: number
  label: string
}) {
  if (
    value === null ||
    !Number.isFinite(value) ||
    !Number.isFinite(maximum) ||
    maximum <= 0 ||
    value < 0 ||
    value > maximum
  )
    return <span aria-label={`${label}: not available`}>Not available</span>
  return (
    <span className="score-bar">
      <span>
        {value} / {maximum}
      </span>
      <meter aria-label={label} min={0} max={maximum} value={value} />
    </span>
  )
}
