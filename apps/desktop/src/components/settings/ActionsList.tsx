import { useCallback } from "react";
import { toast } from "sonner";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Action } from "../../types";
import { actionLabel } from "../../lib/actions";

interface ActionsListProps {
  actions: Action[];
  onChange: (next: Action[]) => void;
}

function newActionId(): string {
  return `act_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function ActionsList({ actions, onChange }: ActionsListProps) {
  const updateAction = useCallback(
    (id: string, patch: Partial<Pick<Action, "name" | "script">>) => {
      onChange(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    },
    [actions, onChange],
  );

  const addAction = useCallback(() => {
    const next: Action = {
      id: newActionId(),
      name: "",
      script: "",
    };
    onChange([...actions, next]);
  }, [actions, onChange]);

  const deleteAction = useCallback(
    (id: string) => {
      const index = actions.findIndex((a) => a.id === id);
      if (index < 0) return;
      const removed = actions[index];
      const next = actions.filter((a) => a.id !== id);
      onChange(next);
      toast(`Deleted "${actionLabel(removed)}"`, {
        action: {
          label: "Undo",
          onClick: () => {
            // Restore at the original index. Using the latest committed
            // `actions` is wrong here (parent may have changed); we want the
            // value as the user last saw it.
            const restored = [...next];
            restored.splice(index, 0, removed);
            onChange(restored);
          },
        },
      });
    },
    [actions, onChange],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = actions.findIndex((a) => a.id === active.id);
      const newIndex = actions.findIndex((a) => a.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      onChange(arrayMove(actions, oldIndex, newIndex));
    },
    [actions, onChange],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Actions</h3>
          <p className="text-sm text-muted-foreground">
            Named scripts surfaced in the worktree's run dropdown. Triggered by the
            play button or Cmd+Shift+R.
          </p>
        </div>
        <button
          type="button"
          onClick={addAction}
          className="px-3 py-1.5 text-sm font-medium rounded border border-border bg-background hover:bg-accent transition-colors"
        >
          Add action
        </button>
      </div>

      {actions.length === 0 ? (
        <div className="p-4 rounded-lg border border-dashed border-border text-sm text-muted-foreground text-center">
          No actions configured. Click <span className="font-medium">Add action</span> to create one.
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={actions.map((a) => a.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-3">
              {actions.map((action) => (
                <ActionCard
                  key={action.id}
                  action={action}
                  onChange={(patch) => updateAction(action.id, patch)}
                  onDelete={() => deleteAction(action.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

interface ActionCardProps {
  action: Action;
  onChange: (patch: Partial<Pick<Action, "name" | "script">>) => void;
  onDelete: () => void;
}

function ActionCard({ action, onChange, onDelete }: ActionCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: action.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="p-3 rounded-lg border border-border bg-card space-y-2"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Drag to reorder"
          className="cursor-grab active:cursor-grabbing p-1 text-muted-foreground hover:text-foreground touch-none"
          {...attributes}
          {...listeners}
        >
          <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
            <circle cx="3" cy="3" r="1.2" />
            <circle cx="9" cy="3" r="1.2" />
            <circle cx="3" cy="7" r="1.2" />
            <circle cx="9" cy="7" r="1.2" />
            <circle cx="3" cy="11" r="1.2" />
            <circle cx="9" cy="11" r="1.2" />
          </svg>
        </button>
        <input
          type="text"
          value={action.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Action name"
          className="flex-1 px-2 py-1 rounded border border-border bg-background text-sm"
        />
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${action.name || "action"}`}
          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
      <textarea
        value={action.script}
        onChange={(e) => onChange({ script: e.target.value })}
        rows={3}
        placeholder="bun run dev"
        className="w-full px-3 py-2 rounded border border-border bg-background font-mono text-sm resize-y"
      />
    </div>
  );
}
