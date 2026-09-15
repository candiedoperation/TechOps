/**
 * "Add context to this warning".
 *
 * Review context is an attributable human action against one immutable
 * snapshot, so the dialog refuses to post without a snapshot id and without a
 * category -- the API requires the category, and a note filed against no
 * snapshot has nothing to be immutable about.
 *
 * The reviewer's identity is not sent. The server derives it from the bearer
 * token; the client has no business asserting who is reviewing.
 */

import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { errorMessage, requestJson } from "@/api/client"
import { queryKeys } from "@/api/queries"
import { FEEDBACK_REASONS, type FeedbackPayload, type FeedbackReason, type Project } from "@/api/types"
import { HorizonIcon } from "@/components/horizon/icons"
import { Eyebrow } from "@/components/horizon/primitives"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export interface FeedbackTarget {
  project: Project
  snapshotId: string | null
  /** The specific warning the reviewer clicked, when they clicked one. */
  warningId: string | null
}

export function FeedbackDialog({
  target,
  onOpenChange,
}: {
  target: FeedbackTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [category, setCategory] = useState<FeedbackReason | "">("")
  const [note, setNote] = useState("")

  /* A fresh target is a fresh review: never carry a previous project's
     selection or note into it. */
  useEffect(() => {
    setCategory("")
    setNote("")
  }, [target?.project.id, target?.warningId])

  const mutation = useMutation({
    mutationFn: async (payload: FeedbackPayload) => {
      await requestJson<unknown>("/feedback", { method: "POST", body: payload })
    },
    onSuccess: () => {
      onOpenChange(false)
      toast.success("Review context recorded")
      /* The note is stored server-side; refetch so review history reflects it. */
      if (target) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projectSnapshots(target.project.id) })
      }
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Review context could not be recorded."))
    },
  })

  function handleSave() {
    if (!target) return
    if (!category) {
      toast.error("Choose a review category before saving.")
      return
    }
    if (!target.snapshotId) {
      toast.error("This project has no snapshot to attach review context to.")
      return
    }
    mutation.mutate({
      snapshot_id: target.snapshotId,
      project_id: target.project.id,
      warning_id: target.warningId,
      category,
      note: note.trim(),
    })
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <Eyebrow>Context</Eyebrow>
          <DialogTitle>Add context to this warning</DialogTitle>
          <DialogDescription>
            {target
              ? `Add context to the ${target.project.name} warning. Your note will be attached to this immutable snapshot.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FEEDBACK_REASONS.map((reason) => (
            <button
              key={reason.value}
              type="button"
              aria-pressed={category === reason.value}
              onClick={() => setCategory(reason.value)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                category === reason.value
                  ? "border-primary bg-primary/10 text-foreground"
                  : "hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <HorizonIcon name={reason.icon} className="size-4 shrink-0" />
              {reason.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="feedback-note">Optional note</Label>
          <Textarea
            id="feedback-note"
            rows={3}
            placeholder="Optional note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save →"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
