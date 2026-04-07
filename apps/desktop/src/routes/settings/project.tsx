import { projectSettingsRoute } from "../../router";
import { useDataStore } from "../../store";

export function ProjectSettingsRoute() {
  const { projectId } = projectSettingsRoute.useParams();
  const projectPath = decodeURIComponent(projectId);
  const project = useDataStore((s) =>
    s.projects.find((p) => p.path === projectPath)
  );
  const projectName =
    project?.name ??
    projectPath.split("/").filter(Boolean).pop() ??
    projectPath;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{projectName}</h2>
        <p className="text-sm text-muted-foreground mt-1">{projectPath}</p>
      </div>

      <div className="rounded-lg border border-border/50 p-4">
        <h3 className="text-sm font-medium mb-2">Scripts</h3>
        <p className="text-xs text-muted-foreground">
          Project scripts will be configurable here in a future update.
        </p>
      </div>
    </div>
  );
}
