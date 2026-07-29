import { apiFetch } from "./http";
import type {
  CapabilitiesResponse,
  CommitItem,
  DesignContentResponse,
  DesignResponse,
  EventRecord,
  GitDiffResponse,
  GitLogResponse,
  GitState,
  GitWriteRequest,
  GitWriteResult,
  IdeaRecord,
  IssueRecord,
  ListResponse,
  LocalSettings,
  MaterialsResponse,
  MemberRecord,
  RecordEnvelope,
  TaskRecord,
} from "./types";

export function listTasks() {
  return apiFetch<ListResponse<TaskRecord>>("/api/tasks");
}
export function getTask(id: string) {
  return apiFetch<RecordEnvelope<TaskRecord>>(`/api/tasks/${encodeURIComponent(id)}`);
}
export function listIssues() {
  return apiFetch<ListResponse<IssueRecord>>("/api/issues");
}
export function getIssue(id: string) {
  return apiFetch<RecordEnvelope<IssueRecord>>(`/api/issues/${encodeURIComponent(id)}`);
}
export function listIdeas() {
  return apiFetch<ListResponse<IdeaRecord>>("/api/ideas");
}
export function getIdea(id: string) {
  return apiFetch<RecordEnvelope<IdeaRecord>>(`/api/ideas/${encodeURIComponent(id)}`);
}
export function listEvents(params?: { entityType?: string; entityId?: string }) {
  const q = new URLSearchParams();
  if (params?.entityType) q.set("entityType", params.entityType);
  if (params?.entityId) q.set("entityId", params.entityId);
  const qs = q.toString();
  return apiFetch<ListResponse<EventRecord>>(`/api/events${qs ? `?${qs}` : ""}`);
}
export function listMembers() {
  return apiFetch<ListResponse<MemberRecord>>("/api/members");
}
export function getSettings() {
  return apiFetch<RecordEnvelope<LocalSettings>>("/api/settings");
}
export function getCapabilities() {
  return apiFetch<CapabilitiesResponse>("/api/capabilities");
}
export function getActionSchema(action: string) {
  return apiFetch<Record<string, unknown>>(`/api/schemas/actions/${encodeURIComponent(action)}`);
}
export function getMaterials() {
  return apiFetch<MaterialsResponse>("/api/materials");
}
export function getMaterialContent(relativePath: string) {
  return apiFetch<{ path: string; contentType: string; body?: string; url?: string }>(
    `/api/materials/content?path=${encodeURIComponent(relativePath)}`,
  );
}
export function getDesign() {
  return apiFetch<DesignResponse>("/api/design");
}
export function getDesignContent(relativePath: string) {
  return apiFetch<DesignContentResponse>(`/api/design/content?path=${encodeURIComponent(relativePath)}`);
}
export function getGitStatus() {
  return apiFetch<GitState>("/api/git/status");
}
export function getGitLog() {
  return apiFetch<GitLogResponse>("/api/git/log");
}
export function getGitDiff(params?: { commit?: string; files?: string[] }) {
  const q = new URLSearchParams();
  if (params?.commit) q.set("commit", params.commit);
  for (const file of params?.files ?? []) q.append("file", file);
  const qs = q.toString();
  return apiFetch<GitDiffResponse>(`/api/git/diff${qs ? `?${qs}` : ""}`);
}
export function postGitFetch() {
  return apiFetch<GitWriteResult>("/api/git/fetch", { method: "POST", body: JSON.stringify({}) });
}
export function postGitPull(body: GitWriteRequest) {
  return apiFetch<GitWriteResult>("/api/git/pull", { method: "POST", body: JSON.stringify(body) });
}
export function postGitCommit(body: GitWriteRequest) {
  return apiFetch<GitWriteResult>("/api/git/commit", { method: "POST", body: JSON.stringify(body) });
}
export function postGitPush(body: GitWriteRequest) {
  return apiFetch<GitWriteResult>("/api/git/push", { method: "POST", body: JSON.stringify(body) });
}
export type { CommitItem };
