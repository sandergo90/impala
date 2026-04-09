export function TabPill({
  label,
  isActive,
  onClick,
  disabled,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1 text-md font-medium rounded-[5px] transition-colors ${
        isActive
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
      style={isActive ? { background: "var(--accent)" } : undefined}
    >
      {label}
    </button>
  );
}
