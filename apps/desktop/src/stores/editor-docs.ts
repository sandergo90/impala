import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  buildDocumentKey,
  deleteBuffer,
  discard,
  getBaseline,
  getCurrent,
  isInitialized,
  markSaved,
  setCurrent,
  setLoaded,
} from "../lib/editor-buffer-registry";

export type EditorDocStatus = "loading" | "ready" | "saving";

export interface EditorDoc {
  key: string;
  worktreePath: string;
  filePath: string;
  status: EditorDocStatus;
  dirty: boolean;
  baselineRevision: string | null;
  hasExternalDiskChange: boolean;
  loadError: string | null;
}

export type SaveOutcome =
  | { kind: "ok" }
  | { kind: "conflict"; diskContent: string | null; currentRevision: string | null }
  | { kind: "error"; message: string };

interface EditorDocsState {
  docs: Record<string, EditorDoc>;
  ensureDoc: (worktreePath: string, filePath: string) => EditorDoc;
  loadDoc: (worktreePath: string, filePath: string) => Promise<void>;
  updateDraft: (key: string, content: string) => void;
  saveDoc: (key: string) => Promise<SaveOutcome>;
  discardDoc: (key: string) => void;
  setExternalChange: (key: string, value: boolean) => void;
  reloadFromDisk: (key: string) => Promise<void>;
  removeDoc: (key: string) => void;
}

interface ReadFileResult {
  content: string;
  revision: string;
}

type WriteResult =
  | { kind: "ok"; revision: string }
  | { kind: "conflict"; currentRevision: string | null };

type SetState = (
  partial:
    | EditorDocsState
    | Partial<EditorDocsState>
    | ((state: EditorDocsState) => EditorDocsState | Partial<EditorDocsState>),
) => void;

function patch(set: SetState, key: string, updates: Partial<EditorDoc>): void {
  set((state) => {
    const existing = state.docs[key];
    if (!existing) return state;
    return { docs: { ...state.docs, [key]: { ...existing, ...updates } } };
  });
}

export const useEditorDocsStore = create<EditorDocsState>((set, get) => ({
  docs: {},

  ensureDoc(worktreePath, filePath) {
    const key = buildDocumentKey(worktreePath, filePath);
    const existing = get().docs[key];
    if (existing) return existing;
    const doc: EditorDoc = {
      key,
      worktreePath,
      filePath,
      status: "loading",
      dirty: false,
      baselineRevision: null,
      hasExternalDiskChange: false,
      loadError: null,
    };
    set((s) => ({ docs: { ...s.docs, [key]: doc } }));
    return doc;
  },

  async loadDoc(worktreePath, filePath) {
    const key = buildDocumentKey(worktreePath, filePath);
    get().ensureDoc(worktreePath, filePath);
    try {
      const result = await invoke<ReadFileResult>("read_file_with_revision", {
        absolutePath: `${worktreePath}/${filePath}`,
      });
      setLoaded(key, result.content);
      patch(set, key, {
        status: "ready",
        dirty: false,
        baselineRevision: result.revision,
        hasExternalDiskChange: false,
        loadError: null,
      });
    } catch (e) {
      patch(set, key, {
        status: "ready",
        loadError: String(e),
      });
    }
  },

  updateDraft(key, content) {
    setCurrent(key, content);
    const dirty = content !== getBaseline(key);
    patch(set, key, { dirty });
  },

  async saveDoc(key) {
    const doc = get().docs[key];
    if (!doc) return { kind: "error", message: "no doc" };
    if (!isInitialized(key)) return { kind: "error", message: "not loaded" };
    patch(set, key, { status: "saving" });
    const content = getCurrent(key);
    try {
      const result = await invoke<WriteResult>("write_file_with_precondition", {
        absolutePath: `${doc.worktreePath}/${doc.filePath}`,
        content,
        ifMatch: doc.baselineRevision,
      });
      if (result.kind === "ok") {
        markSaved(key, content);
        const stillDirty = getCurrent(key) !== content;
        patch(set, key, {
          status: "ready",
          dirty: stillDirty,
          baselineRevision: result.revision,
          hasExternalDiskChange: false,
        });
        return { kind: "ok" };
      }
      patch(set, key, {
        status: "ready",
        hasExternalDiskChange: true,
      });
      let diskContent: string | null = null;
      try {
        const fresh = await invoke<ReadFileResult>("read_file_with_revision", {
          absolutePath: `${doc.worktreePath}/${doc.filePath}`,
        });
        diskContent = fresh.content;
        patch(set, key, { baselineRevision: fresh.revision });
      } catch {
        // best-effort
      }
      return { kind: "conflict", diskContent, currentRevision: result.currentRevision };
    } catch (e) {
      patch(set, key, { status: "ready" });
      return { kind: "error", message: String(e) };
    }
  },

  discardDoc(key) {
    discard(key);
    patch(set, key, { dirty: false, hasExternalDiskChange: false });
  },

  setExternalChange(key, value) {
    patch(set, key, { hasExternalDiskChange: value });
  },

  async reloadFromDisk(key) {
    const doc = get().docs[key];
    if (!doc) return;
    try {
      const result = await invoke<ReadFileResult>("read_file_with_revision", {
        absolutePath: `${doc.worktreePath}/${doc.filePath}`,
      });
      setLoaded(key, result.content);
      patch(set, key, {
        dirty: false,
        baselineRevision: result.revision,
        hasExternalDiskChange: false,
      });
    } catch (e) {
      patch(set, key, { loadError: String(e) });
    }
  },

  removeDoc(key) {
    deleteBuffer(key);
    set((s) => {
      const { [key]: _drop, ...rest } = s.docs;
      return { docs: rest };
    });
  },
}));
