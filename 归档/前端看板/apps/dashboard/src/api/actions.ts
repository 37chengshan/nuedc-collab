import { apiFetch } from "./http";
import { assertIdempotencyKey } from "./idempotency";
import type { ActionRequest, ActionSuccess, DomainActionName } from "./types";
import { ACTION_NAMES } from "./types";

export function isDomainAction(name: string): name is DomainActionName {
  return (ACTION_NAMES as readonly string[]).includes(name);
}

export async function postAction(
  action: DomainActionName,
  request: ActionRequest,
): Promise<ActionSuccess> {
  if (typeof action !== "string" || action.startsWith("git.")) {
    throw new Error("禁止通过通用动作端点调用 git.*");
  }
  if (!isDomainAction(action)) {
    throw new Error(`不支持的领域动作: ${action}`);
  }
  assertIdempotencyKey(request.idempotencyKey);

  return apiFetch<ActionSuccess>(`/api/actions/${action}`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}
