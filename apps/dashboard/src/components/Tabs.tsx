import { cn } from "@/lib/format";

export function Tabs({
  items,
  value,
  onChange,
}: {
  items: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="tablist" className="inline-flex flex-wrap gap-1 rounded-control border border-border bg-muted p-1">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={cn(
              "rounded-[7px] px-3 py-2 text-sm transition-colors duration-hover",
              active ? "bg-panel text-ink shadow-soft" : "text-subtle hover:text-body",
            )}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
