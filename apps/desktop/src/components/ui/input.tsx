"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The single text-field vocabulary for the app.
 *
 * Geometry (`h-8 px-2.5 rounded-md`) matches `ui/button.tsx` so fields and
 * their adjacent buttons line up.
 */
const inputClassName =
  "flex h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm text-foreground transition-colors outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20"

function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputClassName, className)}
      {...props}
    />
  )
}

/**
 * Read-only value display styled to share the Input geometry — use this instead
 * of a real `<input readOnly>` when the value is not editable, so it aligns with
 * sibling controls without becoming a focus stop.
 */
function InputDisplay({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-display"
      className={cn(
        "flex h-8 w-full min-w-0 items-center truncate rounded-md border border-border bg-background px-2.5 text-sm text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Input, InputDisplay, inputClassName }
