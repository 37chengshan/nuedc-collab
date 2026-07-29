import type { ReactNode } from "react";
import { Button } from "./Button";
import { Card } from "./Card";

export function ConfirmPanel({
  title,
  summary,
  impact,
  nextStep,
  confirmLabel = "确认执行",
  cancelLabel = "取消",
  loading,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  summary: string;
  impact?: string;
  nextStep?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <Card className="space-y-4 border-orange/30 bg-orange-soft/30">
      <div>
        <h3 className="font-title text-lg text-ink">{title}</h3>
        <p className="mt-1 text-sm text-body">{summary}</p>
        {impact ? <p className="mt-2 text-sm text-subtle">影响：{impact}</p> : null}
        {nextStep ? <p className="text-sm text-subtle">失败时：{nextStep}</p> : null}
      </div>
      {children}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={loading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="secondary" disabled={loading} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </Card>
  );
}
