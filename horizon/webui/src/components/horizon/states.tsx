/**
 * Loading, empty and error surfaces.
 *
 * Every data surface in the app uses these three, so a reviewer can always
 * tell "still loading" from "nothing here" from "this failed" -- and an error
 * never renders as an empty list, which would read as a real absence.
 */

import type { ReactNode } from "react"
import { AlertTriangleIcon, DatabaseIcon, Loader2Icon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export function LoadingPanel({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-3 py-8" aria-busy="true" aria-live="polite">
        <span className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          {label}
        </span>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-5/6" />
      </CardContent>
    </Card>
  )
}

export function StatGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
      {Array.from({ length: count }).map((_, index) => (
        <Card key={index}>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-3 w-12" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export function TableSkeletonRows({ rows = 5, columns }: { rows?: number; columns: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <TableRow key={rowIndex}>
          {Array.from({ length: columns }).map((__, cellIndex) => (
            <TableCell key={cellIndex}>
              <Skeleton className="h-4 w-full max-w-[10rem]" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

export function ErrorPanel({
  message,
  onRetry,
  title = "Unavailable",
  className,
}: {
  message: string
  onRetry?: () => void
  title?: string
  className?: string
}) {
  return (
    <Alert variant="destructive" className={cn("items-center", className)}>
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function EmptyPanel({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
        <span className="text-muted-foreground" aria-hidden="true">
          {icon ?? <DatabaseIcon className="size-8" />}
        </span>
        <h2 className="text-base font-medium">{title}</h2>
        {description ? <p className="text-muted-foreground max-w-prose text-sm">{description}</p> : null}
        {action}
      </CardContent>
    </Card>
  )
}

/** The in-table version of {@link EmptyPanel}, so an empty result keeps the
 *  table's shape instead of collapsing it. */
export function EmptyTableRow({ columns, message }: { columns: number; message: string }) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="h-28 text-center">
        <span className="text-muted-foreground text-sm">{message}</span>
      </TableCell>
    </TableRow>
  )
}
