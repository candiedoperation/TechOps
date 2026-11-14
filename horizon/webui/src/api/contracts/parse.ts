export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object')
  return value as Record<string, unknown>
}

export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected text')
  return value
}

export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected number')
  return value
}

export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Expected boolean')
  return value
}

export function nullable<T>(parse: (value: unknown) => T) {
  return (value: unknown) => (value == null ? null : parse(value))
}

export function oneOf<const T extends string>(value: unknown, choices: readonly T[]): T {
  const match = choices.find((choice) => choice === value)
  if (match === undefined) throw new Error('Unexpected value')
  return match
}

export function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Expected array')
  return value.map(parse)
}

export function date(value: unknown): string {
  const text = string(value)
  if (!Number.isFinite(Date.parse(text))) throw new Error('Expected date')
  return text
}
