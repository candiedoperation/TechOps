import { createContext } from "react"

export interface OperatorSessionValue {
  /** True once an operator has signed in during this page's lifetime. */
  signedIn: boolean
  /** True when a host integration supplied `window.PHI_API_TOKEN`. The main
   *  UI is authenticated that way and hides the sign-in control. */
  hostProvided: boolean
  signIn: (token: string) => void
  signOut: () => void
}

export const OperatorSessionContext = createContext<OperatorSessionValue | null>(null)
