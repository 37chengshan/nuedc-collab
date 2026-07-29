import type { HealthResponse } from "./types";

let authToken: string | null = null;
let healthPromise: Promise<HealthResponse> | null = null;

export function getAuthToken(): string | null {
  return authToken;
}

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export async function ensureSession(fetcher: typeof fetch = fetch): Promise<HealthResponse> {
  if (!healthPromise) {
    healthPromise = (async () => {
      const res = await fetcher("/api/health", { headers: { Accept: "application/json" } });
      if (!res.ok) {
        throw new Error(`健康检查失败：HTTP ${res.status}`);
      }
      const data = (await res.json()) as HealthResponse & { localAuthToken?: string };
      const headerToken = res.headers.get("X-Local-Auth");
      const token = data.localAuthToken || headerToken;
      if (token) setAuthToken(token);
      return data;
    })().catch((err) => {
      healthPromise = null;
      throw err;
    });
  }
  return healthPromise;
}

export function resetSession(): void {
  authToken = null;
  healthPromise = null;
}
