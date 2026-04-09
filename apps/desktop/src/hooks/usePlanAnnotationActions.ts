import { useCallback, useEffect, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { useUIStore, useDataStore } from "../store";
import { planSqliteProvider } from "../providers/plan-sqlite-provider";
import type { Plan, PlanAnnotation } from "../types";

export function usePlanAnnotationActions() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const worktreePath = selectedWorktree?.path ?? "";

  const navState = useUIStore((s) =>
    worktreePath ? (s.worktreeNavStates[worktreePath] ?? null) : null
  );
  const dataState = useDataStore((s) =>
    worktreePath ? (s.worktreeDataStates[worktreePath] ?? null) : null
  );

  const activePlanId = navState?.activePlanId ?? null;
  const plans = dataState?.plans ?? [];
  const planAnnotations = dataState?.planAnnotations ?? [];
  const activePlan = useMemo(
    () => plans.find((p) => p.id === activePlanId) ?? null,
    [plans, activePlanId]
  );

  const updateData = useCallback(
    (updates: Partial<{ plans: typeof plans; planAnnotations: PlanAnnotation[] }>) => {
      if (worktreePath) {
        useDataStore.getState().updateWorktreeDataState(worktreePath, updates);
      }
    },
    [worktreePath]
  );

  // Refresh plans and plan annotations when DB changes externally (MCP server)
  useEffect(() => {
    if (!worktreePath) return;
    const unlisten = listen("annotations-changed", async () => {
      try {
        const fetchedPlans = await planSqliteProvider.listPlans(worktreePath);
        const updates: Record<string, unknown> = { plans: fetchedPlans };

        // Also refresh annotations if we have an active plan
        const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
        const plan = fetchedPlans.find((p) => p.id === nav.activePlanId);
        if (plan) {
          const anns = await planSqliteProvider.listAnnotations(plan.plan_path, worktreePath);
          updates.planAnnotations = anns;
        }

        useDataStore.getState().updateWorktreeDataState(worktreePath, updates);
      } catch {
        // ignore
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [worktreePath]);

  // Fetch plans on mount / worktree change
  useEffect(() => {
    if (!worktreePath) return;
    planSqliteProvider.listPlans(worktreePath).then((p) => {
      updateData({ plans: p });
    }).catch(() => {});
  }, [worktreePath, updateData]);

  useEffect(() => {
    if (!activePlan) {
      const current = useDataStore.getState().getWorktreeDataState(worktreePath).planAnnotations;
      if (current.length > 0) updateData({ planAnnotations: [] });
      return;
    }
    planSqliteProvider
      .listAnnotations(activePlan.plan_path, worktreePath)
      .then((anns) => updateData({ planAnnotations: anns }))
      .catch(() => {});
  }, [activePlan?.id, activePlan?.plan_path, worktreePath, updateData]);

  const handleCreate = useCallback(
    async (body: string, lineNumber: number) => {
      if (!worktreePath || !activePlan) return;
      const created = await planSqliteProvider.createAnnotation({
        plan_path: activePlan.plan_path,
        worktree_path: worktreePath,
        line_number: lineNumber,
        body,
      });
      const current =
        useDataStore.getState().getWorktreeDataState(worktreePath).planAnnotations;
      updateData({ planAnnotations: [...current, created] });
    },
    [worktreePath, activePlan, updateData]
  );

  const handleResolve = useCallback(
    async (id: string, resolved: boolean) => {
      if (!worktreePath) return;
      const updated = await planSqliteProvider.updateAnnotation(id, { resolved });
      const current =
        useDataStore.getState().getWorktreeDataState(worktreePath).planAnnotations;
      updateData({
        planAnnotations: current.map((a) => (a.id === id ? updated : a)),
      });
    },
    [worktreePath, updateData]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!worktreePath) return;
      await planSqliteProvider.deleteAnnotation(id);
      const current =
        useDataStore.getState().getWorktreeDataState(worktreePath).planAnnotations;
      updateData({
        planAnnotations: current.filter((a) => a.id !== id),
      });
    },
    [worktreePath, updateData]
  );

  const handleSetStatus = useCallback(
    async (status: Plan["status"]) => {
      if (!activePlan) return;
      const updated = await planSqliteProvider.updatePlan(activePlan.id, { status });
      const currentPlans =
        useDataStore.getState().getWorktreeDataState(worktreePath).plans;
      updateData({
        plans: currentPlans.map((p) => (p.id === updated.id ? updated : p)),
      });
    },
    [activePlan, worktreePath, updateData]
  );

  const handleApprove = useCallback(
    () => handleSetStatus("approved"),
    [handleSetStatus]
  );

  const handleRequestChanges = useCallback(
    () => handleSetStatus("changes_requested"),
    [handleSetStatus]
  );

  const handleOpenFile = useCallback(async () => {
    if (!worktreePath) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      filters: [{ name: "Markdown", extensions: ["md"] }],
      multiple: false,
    });
    if (!path) return;
    const filePath = path as string;
    const title = filePath.split("/").pop()?.replace(/\.md$/, "") ?? "Plan";
    const plan = await planSqliteProvider.createPlan({
      plan_path: filePath,
      worktree_path: worktreePath,
      title,
    });
    const currentPlans =
      useDataStore.getState().getWorktreeDataState(worktreePath).plans;
    updateData({ plans: [...currentPlans, plan] });
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      activeTab: "plan",
      activePlanId: plan.id,
    });
  }, [worktreePath, updateData]);

  return {
    plans,
    activePlan,
    planAnnotations,
    handleCreate,
    handleResolve,
    handleDelete,
    handleApprove,
    handleRequestChanges,
    handleOpenFile,
  };
}
