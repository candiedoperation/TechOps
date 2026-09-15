/** Renders one of Horizon's named icons. The name-to-mark table lives in
 *  `@/lib/icons` so this file exports only a component. */

import { horizonIcon } from "@/lib/icons"

export function HorizonIcon({ name, className }: { name: string | null | undefined; className?: string }) {
  const Icon = horizonIcon(name)
  return <Icon className={className} aria-hidden="true" />
}
