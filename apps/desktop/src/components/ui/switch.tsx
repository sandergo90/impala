"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

/**
 * Toggle switch. Base UI supplies `role="switch"`, `aria-checked`, and keyboard
 * handling — do not hand-roll them.
 *
 * Always give it an accessible name: either `aria-label`, or `aria-labelledby`
 * pointing at the row's title element.
 *
 * The off-state track uses `bg-muted-foreground` (not `border` or a faded
 * variant) so both the track-against-panel and thumb-against-track boundaries
 * clear 3:1 (WCAG 1.4.11) in every theme. The `before:` pseudo-element widens
 * the hit area past 24px without changing the rendered size.
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 outline-none transition-colors",
        "bg-muted-foreground data-checked:bg-primary",
        "before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']",
        "disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="size-4 rounded-full bg-background transition-transform data-checked:translate-x-4"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
