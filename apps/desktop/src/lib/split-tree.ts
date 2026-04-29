import type { SplitNode } from "../types";

let paneCounter = 0;

/** Derive a PTY session ID from a pane ID */
export function paneSessionId(paneId: string): string {
  return `pty-${paneId}`;
}

/** Create a new leaf node with a unique ID */
export function createLeaf(paneType: "agent" | "shell" = "shell"): Extract<SplitNode, { type: "leaf" }> {
  return { type: "leaf", id: `pane-${Date.now()}-${paneCounter++}`, paneType };
}

/** Get all leaf nodes in the tree (left-to-right, top-to-bottom order) */
export function getLeaves(node: SplitNode): Extract<SplitNode, { type: "leaf" }>[] {
  if (node.type === "leaf") return [node];
  return [...getLeaves(node.first), ...getLeaves(node.second)];
}

/** Find a leaf by ID */
export function findLeaf(
  node: SplitNode,
  id: string
): Extract<SplitNode, { type: "leaf" }> | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  return findLeaf(node.first, id) ?? findLeaf(node.second, id);
}

/**
 * Split a leaf node into two panes.
 * The existing leaf stays as `first`, the new leaf becomes `second`.
 * Returns the new tree and the new leaf's ID.
 */
export function splitNode(
  tree: SplitNode,
  targetId: string,
  orientation: "horizontal" | "vertical"
): { tree: SplitNode; newLeafId: string } | null {
  const newLeaf = createLeaf("shell");

  const replaced = replaceNode(tree, targetId, (leaf) => ({
    type: "split" as const,
    orientation,
    ratio: 0.5,
    first: leaf,
    second: newLeaf,
  }));

  if (!replaced) return null;
  return { tree: replaced, newLeafId: newLeaf.id };
}

/**
 * Remove a leaf node from the tree.
 * Its sibling takes the parent's place.
 * Returns the new tree, or null if the leaf is the root (last pane).
 */
export function removeNode(
  tree: SplitNode,
  targetId: string
): SplitNode | null {
  if (tree.type === "leaf") {
    return tree.id === targetId ? null : tree;
  }

  if (tree.first.type === "leaf" && tree.first.id === targetId) {
    return tree.second;
  }
  if (tree.second.type === "leaf" && tree.second.id === targetId) {
    return tree.first;
  }

  const newFirst = removeNode(tree.first, targetId);
  if (newFirst !== tree.first) {
    return newFirst === null ? tree.second : { ...tree, first: newFirst };
  }

  const newSecond = removeNode(tree.second, targetId);
  if (newSecond !== tree.second) {
    return newSecond === null ? tree.first : { ...tree, second: newSecond };
  }

  return tree;
}

/**
 * Get the next/previous leaf ID for keyboard navigation.
 * `direction`: 1 for next (Cmd+]), -1 for previous (Cmd+[)
 */
export function getAdjacentLeafId(
  tree: SplitNode,
  currentId: string,
  direction: 1 | -1
): string {
  const leaves = getLeaves(tree);
  const idx = leaves.findIndex((l) => l.id === currentId);
  if (idx === -1) return leaves[0]?.id ?? currentId;
  const nextIdx = (idx + direction + leaves.length) % leaves.length;
  return leaves[nextIdx].id;
}

/**
 * Update the ratio of a split node that contains a specific child.
 * Used when the user drags a resize handle.
 */
export function updateRatio(
  tree: SplitNode,
  splitId: string,
  ratio: number
): SplitNode {
  if (tree.type === "leaf") return tree;
  if (
    tree.type === "split" &&
    ((tree.first.type === "leaf" && tree.first.id === splitId) ||
      (tree.first.type === "split" && getLeaves(tree.first)[0]?.id === splitId))
  ) {
    return { ...tree, ratio };
  }
  return {
    ...tree,
    first: updateRatio(tree.first, splitId, ratio),
    second: updateRatio(tree.second, splitId, ratio),
  };
}

/** Internal helper: replace a leaf node using a transform function */
function replaceNode(
  tree: SplitNode,
  targetId: string,
  transform: (leaf: Extract<SplitNode, { type: "leaf" }>) => SplitNode
): SplitNode | null {
  if (tree.type === "leaf") {
    if (tree.id === targetId) return transform(tree);
    return null;
  }

  const newFirst = replaceNode(tree.first, targetId, transform);
  if (newFirst) return { ...tree, first: newFirst };

  const newSecond = replaceNode(tree.second, targetId, transform);
  if (newSecond) return { ...tree, second: newSecond };

  return null;
}
