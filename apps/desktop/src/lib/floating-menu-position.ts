export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export function positionFloatingMenu(
  anchor: RectLike,
  viewport: Size,
  menu: Size,
  margin = 8,
): { left: number; top: number } {
  const left = Math.max(
    margin,
    Math.min(anchor.left, viewport.width - menu.width - margin),
  );
  const below = anchor.bottom;
  const top = below + menu.height <= viewport.height - margin
    ? below
    : Math.max(margin, anchor.top - menu.height);
  return { left, top };
}
