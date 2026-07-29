import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/format";

export function Card({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-panel border border-border bg-panel p-4 shadow-soft",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
