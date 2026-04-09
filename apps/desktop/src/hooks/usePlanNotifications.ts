import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { planSqliteProvider } from "../providers/plan-sqlite-provider";

export function usePlanNotifications() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const worktreePath = selectedWorktree?.path ?? "";
  const prevPlanIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!worktreePath) return;

    planSqliteProvider.listPlans(worktreePath).then((plans) => {
      prevPlanIdsRef.current = new Set(plans.map((p) => p.id));
    }).catch(() => {});

    const unlisten = listen("annotations-changed", async () => {
      try {
        const plans = await planSqliteProvider.listPlans(worktreePath);
        const currentIds = new Set(plans.map((p) => p.id));
        const prev = prevPlanIdsRef.current;

        for (const plan of plans) {
          if (plan.status === "pending" && !prev.has(plan.id)) {
            const title = plan.title ?? plan.plan_path.split("/").pop() ?? "Plan";

            useDataStore.getState().updateWorktreeDataState(worktreePath, {
              hasPendingPlan: true,
              plans,
            });

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

        prevPlanIdsRef.current = currentIds;
      } catch {
        // ignore
      }
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [worktreePath]);

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
