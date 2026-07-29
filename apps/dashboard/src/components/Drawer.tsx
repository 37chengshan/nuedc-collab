import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useMotion } from "@/hooks/useMotion";
import { cn } from "@/lib/format";
import { Button } from "./Button";

export function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  side = "right",
  widthClassName = "max-w-md",
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  side?: "right" | "left";
  widthClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { duration } = useMotion();
  useFocusTrap(open, ref, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        aria-label="关闭抽屉背景"
        className="absolute inset-0 bg-ink/30"
        onClick={onClose}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        className={cn(
          "absolute top-0 flex h-full w-full flex-col border-border bg-panel shadow-soft",
          side === "right" ? "right-0 border-l" : "left-0 border-r",
          widthClassName,
        )}
        style={{
          transitionDuration: `${duration("drawer")}ms`,
          animation: `${side === "right" ? "drawer-right" : "drawer-left"} ${duration("drawer")}ms ease`,
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 id="drawer-title" className="font-title text-xl text-ink">{title}</h2>
            {description ? <p className="mt-1 text-sm text-subtle">{description}</p> : null}
          </div>
          <Button variant="ghost" size="sm" aria-label="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
      </div>
      <style>{`@keyframes drawer-right { from { transform: translateX(100%); opacity: 0.8;} to { transform: none; opacity: 1; } } @keyframes drawer-left { from { transform: translateX(-100%); opacity: 0.8;} to { transform: none; opacity: 1; } }`}</style>
    </div>
  );
}
