// Dev preview route for the ProseMark walking skeleton (Phase 1 / Task 2).
// Reachable at #/_dev-prosemark while running `bun run dev`.
// Task 5 of the plan deletes this file together with the route registration in router.tsx.
import { useState } from "react";
import { ProseMarkEditor } from "../components/markdown-editor";

export function DevProsemarkRoute() {
  const [value, setValue] = useState(
    `# Title

Some text.

| col A | col B |
|-------|-------|
| one   | two   |

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

<details>
<summary>HTML block</summary>
Hidden content.
</details>

\`\`\`ts
const x: number = 1;
\`\`\`
`,
  );
  return (
    <div className="h-screen flex flex-col">
      <div className="p-2 border-b text-xs">dev preview — delete before merging</div>
      <ProseMarkEditor
        value={value}
        onChange={setValue}
        onSave={() => console.log("save:", value)}
        filePath="dev.md"
        autoFocus
        className="flex-1 overflow-auto"
      />
    </div>
  );
}
