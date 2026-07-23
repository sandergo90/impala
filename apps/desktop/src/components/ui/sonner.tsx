import { useSyncExternalStore } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * Track the active theme's light/dark type, which applyTheme() writes to
 * `<html data-theme-type>`. Sonner styles its description text with a hardcoded
 * literal under `[data-sonner-theme=dark]` that no CSS variable can override,
 * so pinning `theme="dark"` renders near-invisible descriptions (~1.1:1) under
 * any light theme.
 */
function subscribeThemeType(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme-type"],
  })
  return () => observer.disconnect()
}

function useThemeType(): "light" | "dark" {
  return useSyncExternalStore(
    subscribeThemeType,
    () => (document.documentElement.getAttribute("data-theme-type") === "light" ? "light" : "dark"),
    () => "dark" as const,
  )
}

const Toaster = ({ ...props }: ToasterProps) => {
  const themeType = useThemeType()

  return (
    <Sonner
      theme={themeType}
      closeButton
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
