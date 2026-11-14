export const demoScenarios = [
  'success',
  'empty',
  'loading',
  'slow',
  'error',
  'unauthorized',
  'forbidden',
  'stale',
  'provisional',
  'missing',
] as const
export type DemoScenario = (typeof demoScenarios)[number]
export function isDemoScenario(value: unknown): value is DemoScenario {
  return demoScenarios.some((scenario) => scenario === value)
}
