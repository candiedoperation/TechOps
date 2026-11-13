import { createContext, useContext } from 'react'
import type { HorizonReadContractRegistry } from '../api/contracts/registry'
import type { DemoScenario } from './scenarios'

export const DemoContext = createContext<{
  scenario: DemoScenario
  changeScenario: (scenario: DemoScenario) => void
  registry: HorizonReadContractRegistry
} | null>(null)

export function useDemo() {
  const context = useContext(DemoContext)
  if (!context) throw new Error('Demo controls require the isolated demo provider.')
  return context
}
