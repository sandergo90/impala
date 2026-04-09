import { useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useUIStore, useDataStore } from "../store";
import { planSqliteProvider } from "../providers/plan-sqlite-provider";
import type { PlanAnnotation } from "../types";

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
  const activePlan = plans.find((p) => p.id === activePlanId) ?? null;

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

  // Fetch plan annotations when active plan changes
  useEffect(() => {
    if (!activePlan) {
      updateData({ planAnnotations: [] });
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

  const handleApprove = useCallback(async () => {
    if (!activePlan) return;
    const updated = await planSqliteProvider.updatePlan(activePlan.id, {
      status: "approved",
    });
    const currentPlans =
      useDataStore.getState().getWorktreeDataState(worktreePath).plans;
    updateData({
      plans: currentPlans.map((p) => (p.id === updated.id ? updated : p)),
    });
  }, [activePlan, worktreePath, updateData]);

  const handleRequestChanges = useCallback(async () => {
    if (!activePlan) return;
    const updated = await planSqliteProvider.updatePlan(activePlan.id, {
      status: "changes_requested",
    });
    const currentPlans =
      useDataStore.getState().getWorktreeDataState(worktreePath).plans;
    updateData({
      plans: currentPlans.map((p) => (p.id === updated.id ? updated : p)),
    });
  }, [activePlan, worktreePath, updateData]);

  return {
    plans,
    activePlan,
    planAnnotations,
    handleCreate,
    handleResolve,
    handleDelete,
    handleApprove,
    handleRequestChanges,
  };
}
