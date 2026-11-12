import { createContext, useContext } from 'react'
import type { AuthState } from './types'

export interface AuthContextValue {
  state: AuthState
  signIn: (returnTo: string) => Promise<void>
  signOut: () => Promise<void>
  invalidateSession: (status?: 401 | 403) => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
