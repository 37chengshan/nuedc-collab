import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useMotion } from "@/hooks/useMotion";
import { cn } from "@/lib/format";
import { Button } from "./Button";

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { duration } = useMotion();
  useFocusTrap(open, ref, onClose);
  if (!open) return null;

  const width =
    size === "sm" ? "max-w-md" : size === "lg" ? "max-w-3xl" : "max-w-xl";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" role="presentation">
      <button
        type="button"
        aria-label="关闭对话框背景"
        className="absolute inset-0 bg-ink/30"
        style={{ transitionDuration: `${duration("menu")}ms` }}
        onClick={onClose}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={cn(
          "relative z-10 w-full rounded-dialog border border-border bg-panel p-5 shadow-soft",
          width,
        )}
        style={{
          transitionDuration: `${duration("menu")}ms`,
          animation: `dialog-in ${duration("menu")}ms ease`,
        }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="dialog-title" className="font-title text-xl text-ink">{title}</h2>
            {description ? <p className="mt-1 text-sm text-subtle">{description}</p> : null}
          </div>
          <Button variant="ghost" size="sm" aria-label="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-4">{children}</div>
        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
      <style>{`@keyframes dialog-in { from { opacity: 0; transform: translateY(8px) scale(0.98);} to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
