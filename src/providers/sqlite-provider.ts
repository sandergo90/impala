import { invoke } from "@tauri-apps/api/core";
import type { Annotation, CommentProvider } from "../types";

export const sqliteProvider: CommentProvider = {
  async list(repo, file, commit) {
    return invoke<Annotation[]>("list_annotations", {
      repo,
      file: file ?? null,
      commit: commit ?? null,
    });
  },
  async create(annotation) {
    return invoke<Annotation>("create_annotation", { annotation });
  },
  async update(id, changes) {
    return invoke<Annotation>("update_annotation", { id, changes });
  },
  async delete(id) {
    await invoke("delete_annotation", { id });
  },
};
