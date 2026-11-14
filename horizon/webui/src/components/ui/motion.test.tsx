import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CountUp } from './CountUp'
import { easedValue, motionAllowed, reducedMotionQuery } from './motion'
import { readFileSync } from 'node:fs'

const motionStyles = readFileSync('src/components/ui/motion.css', 'utf8')

describe('publication motion', () => {
  it('uses a bounded easing curve', () => {
    expect(easedValue(80, 0, 400)).toBe(0)
    expect(easedValue(80, 200, 400)).toBe(70)
    expect(easedValue(80, 400, 400)).toBe(80)
  })

  it('keeps the published number visible and skips frames when motion is reduced', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    render(<CountUp value={82.5} />)
    expect(motionAllowed()).toBe(false)
    expect(window.matchMedia).toHaveBeenCalledWith(reducedMotionQuery)
    expect(screen.getAllByText('82.5')).toHaveLength(2)
    expect(frame).not.toHaveBeenCalled()
    expect(motionStyles).toContain('font-variant-numeric: tabular-nums')
    expect(motionStyles).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
