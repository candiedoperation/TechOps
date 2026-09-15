/**
 * Horizon's icon vocabulary.
 *
 * The vanilla app carried its own inline SVG set keyed by `data-icon`. The
 * names survive -- the API and the evidence normalizer both emit them -- but
 * they now resolve to Lucide, which is the icon library People Portal's
 * `components.json` declares. Keeping the names means an evidence row that
 * asks for `pull` still gets a pull-request mark without either side knowing
 * about the other's icon set.
 */

import {
  ActivityIcon,
  CalendarIcon,
  CheckIcon,
  CircleCheckIcon,
  DatabaseIcon,
  FolderIcon,
  GitPullRequestIcon,
  LayoutGridIcon,
  MessageSquareIcon,
  SparklesIcon,
  SquarePauseIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"

export const HORIZON_ICONS = {
  grid: LayoutGridIcon,
  folder: FolderIcon,
  database: DatabaseIcon,
  calendar: CalendarIcon,
  check: CheckIcon,
  "check-circle": CircleCheckIcon,
  triangle: TriangleAlertIcon,
  pause: SquarePauseIcon,
  message: MessageSquareIcon,
  activity: ActivityIcon,
  pull: GitPullRequestIcon,
  users: UsersIcon,
  sparkle: SparklesIcon,
  trend: TrendingUpIcon,
} satisfies Record<string, LucideIcon>

export type HorizonIconName = keyof typeof HORIZON_ICONS

/** Unknown names fall back to `sparkle`, as the vanilla `icon()` helper did. */
export function horizonIcon(name: string | null | undefined): LucideIcon {
  if (name && name in HORIZON_ICONS) return HORIZON_ICONS[name as HorizonIconName]
  return HORIZON_ICONS.sparkle
}
