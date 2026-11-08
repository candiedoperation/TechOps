/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/styles.css', 'utf8')
const portfolio = readFileSync('src/features/portfolio/portfolio.css', 'utf8')
function rule(source: string, selector: string) {
  const normalized = source.replace(/\s+/g, ' ')
  const start = normalized.indexOf(`${selector} {`)
  if (start < 0) return ''
  return normalized.slice(start + selector.length + 2).split('}')[0] ?? ''
}

describe('Horizon layout regression guards', () => {
  it('insets read filters from the card edge with an auto-fitting grid', () => {
    const controls = rule(css, '.read-controls')
    expect(controls).toContain('padding: 20px')
    expect(controls).toContain('auto-fit')
    expect(controls).toContain('min(100%, 220px)')
    expect(controls).toContain('align-items: end')
  })
  it('aligns field sizes while allowing narrow layouts to shrink', () => {
    const controls = rule(css, '.read-controls input, .read-controls select')
    expect(controls).toContain('width: 100%')
    expect(controls).toContain('min-width: 0')
    expect(controls).toContain('min-height: 42px')
  })
  it('insets component panels and prevents navigation labels splitting', () => {
    expect(rule(css, '.signal-grid')).toContain('padding: 20px')
    expect(rule(portfolio, '.top-nav-link')).toContain('white-space: nowrap')
    expect(rule(portfolio, '.company-project-line .portfolio-status')).toContain('flex-shrink: 0')
  })
})
