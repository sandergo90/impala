"use client";

import type { ReactNode } from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "@/lib/utils";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
}

interface ContextMenuProps {
  children: ReactNode;
  items: ContextMenuItem[];
  className?: string;
}

export function ContextMenu({ children, items, className }: ContextMenuProps) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger
        data-slot="context-menu-trigger"
        className={className}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Positioner sideOffset={4}>
          <ContextMenuPrimitive.Popup
            data-slot="context-menu-popup"
            className={cn(
              "bg-popover text-popover-foreground border border-border rounded-md shadow-md py-1 min-w-[140px] text-sm outline-none",
              "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            )}
          >
            {items.map((item) => (
              <ContextMenuPrimitive.Item
                key={item.label}
                onClick={() => item.onSelect()}
                // `bg-accent` is a no-op on a popover surface — Default Dark
                // resolves --accent and --popover to the same hex. Tinting with
                // the foreground token instead derives a real step from
                // whatever surface the row actually sits on, in every theme.
                className="px-3 py-1.5 cursor-pointer select-none outline-none text-foreground data-highlighted:bg-foreground/10"
              >
                {item.label}
              </ContextMenuPrimitive.Item>
            ))}
          </ContextMenuPrimitive.Popup>
        </ContextMenuPrimitive.Positioner>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
