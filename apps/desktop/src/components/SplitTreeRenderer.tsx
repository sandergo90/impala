import type { ReactNode } from "react";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type { SplitNode } from "../types";
import { getLeaves } from "../lib/split-tree";
import { useUIStore } from "../store";

type GroupNode = Extract<SplitNode, { type: "group" }>;

interface SplitTreeRendererProps {
  tree: SplitNode;
  focusedPaneId: string;
  /**
   * When false, unfocused panes are NOT dimmed (the whole tab is inactive, so
   * a focus indicator would be misleading). Defaults to true.
   */
  isActive?: boolean;
  onFocusPane: (paneId: string) => void;
  /**
   * Persist a divider drag. `splitId` is the leading leaf id of the split's
   * `second` subtree (see `updateRatio`), `ratio` the new size of the first
   * pane (0..1).
   */
  onRatioChange: (splitId: string, ratio: number) => void;
  renderLeaf: (group: GroupNode, isFocused: boolean) => ReactNode;
}

// Split-handle drags must park native browser webviews: pointer events over a
// child webview would swallow the drag. Mirror the divider drag into the store
// flag BrowserPane reads for occlusion (same pattern as MainView's sidebar
// drags). Plain function — only touches the store's imperative API.
function bracketHandleDrag(): void {
  useUIStore.getState().setPanelDragActive(true);
  const end = () => {
    useUIStore.getState().setPanelDragActive(false);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

/**
 * Recursive split-tree renderer shared by every splittable surface (user tabs,
 * the agent system tab, the general terminal). It owns the layout algebra —
 * orientation inversion, focus dimming, divider-drag webview parking, and
 * ratio write-back — while `renderLeaf` fills each pane with content.
 */
export function SplitTreeRenderer(props: SplitTreeRendererProps) {
  return <SplitNodeRenderer node={props.tree} {...props} />;
}

function SplitNodeRenderer({
  node,
  focusedPaneId,
  isActive = true,
  onFocusPane,
  onRatioChange,
  renderLeaf,
}: { node: SplitNode } & Omit<SplitTreeRendererProps, "tree">) {
  if (node.type === "group") {
    const isFocused = node.id === focusedPaneId;
    return (
      <div
        className="h-full w-full relative"
        onMouseDownCapture={() => {
          if (!isFocused) onFocusPane(node.id);
        }}
      >
        {renderLeaf(node, isFocused)}
      </div>
    );
  }

  // SplitNode.orientation is the divider line; ResizablePanelGroup.orientation
  // is the opposite (stacking axis). horizontal divider → vertical stack.
  const panelOrientation =
    node.orientation === "horizontal" ? "vertical" : "horizontal";
  const firstPercent = Math.round(node.ratio * 100);

  // `splitId` (leading leaf of `second`) is globally unique per split, so
  // deriving both panel ids from it keeps them unique across nested groups.
  const splitId = getLeaves(node.second)[0]?.id ?? "";
  const firstPanelId = `${splitId}:a`;
  const secondPanelId = `${splitId}:b`;

  const handleLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const a = layout[firstPanelId];
    const b = layout[secondPanelId];
    if (a == null || b == null) return;
    const total = a + b;
    if (total <= 0) return;
    onRatioChange(splitId, a / total);
  };

  return (
    <ResizablePanelGroup
      orientation={panelOrientation}
      className="h-full w-full"
      onLayoutChanged={handleLayoutChanged}
    >
      <ResizablePanel id={firstPanelId} defaultSize={`${firstPercent}%`} minSize={10}>
        <SplitNodeRenderer
          node={node.first}
          focusedPaneId={focusedPaneId}
          isActive={isActive}
          onFocusPane={onFocusPane}
          onRatioChange={onRatioChange}
          renderLeaf={renderLeaf}
        />
      </ResizablePanel>
      <ResizableHandle withHandle onPointerDown={bracketHandleDrag} />
      <ResizablePanel id={secondPanelId} defaultSize={`${100 - firstPercent}%`} minSize={10}>
        <SplitNodeRenderer
          node={node.second}
          focusedPaneId={focusedPaneId}
          isActive={isActive}
          onFocusPane={onFocusPane}
          onRatioChange={onRatioChange}
          renderLeaf={renderLeaf}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
