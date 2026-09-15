import { useContext } from "react"

import { OperatorSessionContext, type OperatorSessionValue } from "./context"

export function useOperatorSession(): OperatorSessionValue {
  const value = useContext(OperatorSessionContext)
  if (!value) throw new Error("useOperatorSession must be used inside OperatorSessionProvider")
  return value
}
