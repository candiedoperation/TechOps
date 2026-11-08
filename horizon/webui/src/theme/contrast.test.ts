/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function luminance(hex: string) {
  const channels = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}
function ratio(a: string, b: string) {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

describe('Semantic theme contrast', () => {
  const css = readFileSync('src/styles.css', 'utf8')
  const light = css.match(/:root\s*\{([^}]+)\}/)![1]!
  const dark = css.match(/:root\[data-theme=['"]dark['"]\]\s*\{([^}]+)\}/)![1]!
  it.each([
    { theme: 'light', block: light },
    { theme: 'dark', block: dark },
  ])('maintains readable text and focus contrast in $theme', ({ block }) => {
    const tokens = Object.fromEntries(
      [...block.matchAll(/(--[a-z-]+):\s*(#[\da-f]{6})\s*;/gi)].map((match) => [
        match[1]!,
        match[2]!,
      ]),
    )
    for (const foreground of ['--text', '--text-secondary', '--text-muted']) {
      for (const background of ['--background', '--surface', '--surface-secondary'])
        expect(ratio(tokens[foreground]!, tokens[background]!)).toBeGreaterThanOrEqual(4.5)
    }
    for (const [foreground, background] of [
      ['--accent-text', '--accent-surface'],
      ['--on-accent', '--accent'],
      ['--success', '--success-surface'],
      ['--warning', '--warning-surface'],
      ['--danger', '--danger-surface'],
    ])
      expect(ratio(tokens[foreground!]!, tokens[background!]!)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(tokens['--focus']!, tokens['--surface']!)).toBeGreaterThanOrEqual(3)
  })
  it('keeps literal color values within the theme token definitions', () => {
    const components = css.slice(css.indexOf('@theme inline'))
    expect(components).not.toMatch(/#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
  })
})
