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
                className="px-3 py-1.5 cursor-pointer select-none outline-none text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
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
