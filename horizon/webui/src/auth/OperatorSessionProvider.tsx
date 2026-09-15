/**
 * React binding for the in-memory operator session.
 *
 * The token itself never enters React state or a React ref -- it stays in the
 * `session.ts` closure, and this provider only tracks *whether* there is one,
 * so a devtools inspection of the component tree cannot expose it.
 *
 * Signing out drops the token and empties the query cache in the same tick:
 * data fetched under an operator's authority must not survive their sign-out,
 * which is what the vanilla control achieved with a full page reload.
 */

import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { horizonWindow } from "@/commons/config"
import { clearOperatorToken, hasOperatorToken, setOperatorToken, subscribeToSession } from "./session"
import { OperatorSessionContext, type OperatorSessionValue } from "./context"

export function OperatorSessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  const signedIn = useSyncExternalStore(subscribeToSession, hasOperatorToken, () => false)

  const signIn = useCallback(
    (token: string) => {
      setOperatorToken(token)
      /* Anything already cached was fetched unauthenticated (or as somebody
         else); refetch it under the new session rather than showing it. */
      void queryClient.invalidateQueries()
    },
    [queryClient],
  )

  const signOut = useCallback(() => {
    clearOperatorToken()
    queryClient.clear()
  }, [queryClient])

  const hostProvided = horizonWindow().PHI_API_TOKEN !== undefined

  const value = useMemo<OperatorSessionValue>(
    () => ({ signedIn, hostProvided, signIn, signOut }),
    [signedIn, hostProvided, signIn, signOut],
  )

  return <OperatorSessionContext.Provider value={value}>{children}</OperatorSessionContext.Provider>
}
