import type { HorizonAuthAdapter } from './types'

export const AUTH_UNAVAILABLE =
  'Horizon sign-in is not available yet. Protected information remains locked.'

/** Intentionally no endpoint names, browser tokens, or development sign-in bypass. */
export const horizonAuthAdapter: HorizonAuthAdapter = {
  getState: async () => ({ status: 'unavailable', reason: AUTH_UNAVAILABLE }),
  signIn: async () => {
    throw new Error(AUTH_UNAVAILABLE)
  },
  signOut: async () => {
    throw new Error(AUTH_UNAVAILABLE)
  },
}
