import { ApiError } from "@/api/http";

export function toErrorView(error: unknown): { impact: string; nextStep?: string; details?: string } {
  if (error instanceof ApiError) {
    return { impact: error.impact, nextStep: error.nextStep, details: error.details || undefined };
  }
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const impact = String(e.impact || e.message || "请求失败");
    const nextStep = e.nextStep ? String(e.nextStep) : undefined;
    const details = e.details ? String(e.details) : undefined;
    return { impact, nextStep, details };
  }
  if (typeof error === "string") return { impact: error, nextStep: "请稍后重试" };
  return { impact: "未知错误", nextStep: "刷新页面或检查本地服务是否启动" };
}
