import { cn } from "@/lib/format";

export function LoadingState({ label = "加载中…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-panel border border-border bg-surface p-4 text-sm text-subtle", className)} role="status" aria-live="polite">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-orange border-r-transparent" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
