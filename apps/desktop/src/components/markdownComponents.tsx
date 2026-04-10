import type { Components } from "react-markdown";

export const markdownComponents: Partial<Components> = {
  code: ({ className, children }) => {
    const isBlock = className?.startsWith("language-");
    if (isBlock) {
      return (
        <code className={className}>
          {children}
        </code>
      );
    }
    return (
      <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-muted/50 border border-border rounded-md p-4 overflow-x-auto my-4 text-sm font-mono">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-4">
      <table className="w-max min-w-full divide-y divide-border">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2 text-left text-sm font-semibold bg-muted align-top">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 text-sm border-t border-border align-top">
      {children}
    </td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-muted-foreground/30 pl-4 italic my-4">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-8 border-border" />,
  li: ({ children, className }) => {
    const isTaskItem = className?.includes("task-list-item");
    return (
      <li className={isTaskItem ? "list-none flex items-start gap-2" : undefined}>
        {children}
      </li>
    );
  },
};
