import type { ReactNode } from "react";
import { Card } from "./Card";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-start gap-3 bg-surface">
      <div>
        <h3 className="font-title text-lg text-ink">{title}</h3>
        {description ? <p className="mt-1 text-sm text-subtle">{description}</p> : null}
      </div>
      {action}
    </Card>
  );
}
