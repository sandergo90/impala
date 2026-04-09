import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { planSqliteProvider } from "../providers/plan-sqlite-provider";

/**
 * Single listener for plan-related DB changes. Runs in MainView (always mounted).
 * Fetches plans + annotations on `annotations-changed`, detects new pending plans,
 * and shows toast/badge notifications.
 */
export function usePlanNotifications() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const worktreePath = selectedWorktree?.path ?? "";
  const prevPlanIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!worktreePath) return;

    async function refresh() {
      try {
        const plans = await planSqliteProvider.listPlans(worktreePath);
        const updates: Record<string, unknown> = { plans };

        // Detect new pending plans for toast
        const prev = prevPlanIdsRef.current;
        for (const plan of plans) {
          if (plan.status === "pending" && !prev.has(plan.id)) {
            const title = plan.title ?? plan.plan_path.split("/").pop() ?? "Plan";
            updates.hasPendingPlan = true;

            toast("Plan ready for review", {
              description: title,
              action: {
                label: "Review",
                onClick: () => {
                  useUIStore.getState().updateWorktreeNavState(worktreePath, {
                    activeTab: "plan",
                    activePlanId: plan.id,
                  });
                },
              },
            });
            break;
          }
        }
        prevPlanIdsRef.current = new Set(plans.map((p) => p.id));

        // Also refresh annotations if there's an active plan
        const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
        const activePlan = plans.find((p) => p.id === nav.activePlanId);
        if (activePlan) {
          const anns = await planSqliteProvider.listAnnotations(activePlan.plan_path, worktreePath);
          updates.planAnnotations = anns;
        }

        useDataStore.getState().updateWorktreeDataState(worktreePath, updates);
      } catch {
        // ignore
      }
    }

    // Initial fetch
    refresh();

    const unlisten = listen("annotations-changed", refresh);
    return () => { unlisten.then((fn) => fn()); };
  }, [worktreePath]);

  // Clear badge when user switches to plan view
  const navState = useUIStore((s) =>
    worktreePath ? (s.worktreeNavStates[worktreePath] ?? null) : null
  );
  useEffect(() => {
    if (!worktreePath) return;
    if (navState?.activeTab === "plan") {
      const state = useDataStore.getState().getWorktreeDataState(worktreePath);
      if (state.hasPendingPlan) {
        useDataStore.getState().updateWorktreeDataState(worktreePath, {
          hasPendingPlan: false,
        });
      }
    }
  }, [navState?.activeTab, worktreePath]);
}
