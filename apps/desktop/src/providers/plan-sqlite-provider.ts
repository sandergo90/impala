import { invoke } from "@tauri-apps/api/core";
import type { Plan, PlanAnnotation, NewPlanAnnotation } from "../types";

export const planSqliteProvider = {
  async listPlans(worktreePath: string): Promise<Plan[]> {
    return invoke<Plan[]>("list_plans", { worktreePath });
  },

  async createPlan(plan: {
    plan_path: string;
    worktree_path: string;
    title?: string;
  }): Promise<Plan> {
    return invoke<Plan>("create_plan", { plan });
  },

  async getPlan(id: string): Promise<Plan> {
    return invoke<Plan>("get_plan", { id });
  },

  async updatePlan(
    id: string,
    changes: { status?: string; title?: string }
  ): Promise<Plan> {
    return invoke<Plan>("update_plan", { id, changes });
  },

  async listAnnotations(
    planPath: string,
    worktreePath?: string
  ): Promise<PlanAnnotation[]> {
    return invoke<PlanAnnotation[]>("list_plan_annotations", {
      planPath,
      worktreePath: worktreePath ?? null,
    });
  },

  async createAnnotation(
    annotation: NewPlanAnnotation
  ): Promise<PlanAnnotation> {
    return invoke<PlanAnnotation>("create_plan_annotation", { annotation });
  },

  async updateAnnotation(
    id: string,
    changes: { body?: string; resolved?: boolean }
  ): Promise<PlanAnnotation> {
    return invoke<PlanAnnotation>("update_plan_annotation", { id, changes });
  },

  async deleteAnnotation(id: string): Promise<void> {
    await invoke("delete_plan_annotation", { id });
  },
};
