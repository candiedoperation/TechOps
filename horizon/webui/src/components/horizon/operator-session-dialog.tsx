/**
 * The "Operator session" control.
 *
 * A port of the dialog in `assets/operator-session.js`. It is offered on the
 * standalone artifact surfaces (Profiles, Analytics), where there is no host
 * integration to supply a token; the main dashboard receives authentication
 * from its host and shows only the current state.
 *
 * The input is cleared on every open and on submit, and its value goes
 * straight into the in-memory session -- nothing here persists it.
 */

import { useState, type FormEvent } from "react"
import { KeyRoundIcon } from "lucide-react"

import { useOperatorSession } from "@/auth/use-operator-session"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function OperatorSessionDialog() {
  const { signedIn, signIn, signOut } = useOperatorSession()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState("")

  function handleOpenChange(next: boolean) {
    setOpen(next)
    /* Never leave a typed secret sitting in a closed dialog's state. */
    setToken("")
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const value = token.trim()
    setToken("")
    if (!value) return
    signIn(value)
    setOpen(false)
  }

  function handleSignOut() {
    setToken("")
    signOut()
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant={signedIn ? "secondary" : "outline"} size="sm">
          <KeyRoundIcon className="size-4" aria-hidden="true" />
          {signedIn ? "Operator session · signed in" : "Operator session"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Operator session</DialogTitle>
            <DialogDescription>
              The token stays in this tab's memory until you sign out or reload. It is never written to storage.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="operator-token">Access token</Label>
            <Input
              id="operator-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" onClick={handleSignOut} disabled={!signedIn}>
              Sign out
            </Button>
            <div className="flex gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!token.trim()}>
                Sign in
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
