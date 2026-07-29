import type { ReactNode } from "react";
import { Card } from "./Card";
import { Button } from "./Button";

export function ErrorState({
  title = "加载失败",
  impact,
  nextStep,
  details,
  onRetry,
  action,
}: {
  title?: string;
  impact: string;
  nextStep?: string;
  details?: string;
  onRetry?: () => void;
  action?: ReactNode;
}) {
  return (
    <Card className="border-danger/30 bg-danger-soft/40">
      <h3 className="font-title text-lg text-danger">{title}</h3>
      <p className="mt-2 text-sm text-body">{impact}</p>
      {nextStep ? <p className="mt-1 text-sm text-subtle">下一步：{nextStep}</p> : null}
      {details ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-subtle">技术详情</summary>
          <pre className="mt-2 overflow-auto rounded-control bg-panel p-3 font-mono text-xs text-body">{details}</pre>
        </details>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            重试
          </Button>
        ) : null}
        {action}
      </div>
    </Card>
  );
}
