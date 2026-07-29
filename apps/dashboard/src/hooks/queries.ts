import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { postAction } from "@/api/actions";
import {
  getCapabilities,
  getDesign,
  getGitDiff,
  getGitLog,
  getGitStatus,
  getMaterials,
  getSettings,
  listEvents,
  listIdeas,
  listIssues,
  listMembers,
  listTasks,
  postGitCommit,
  postGitFetch,
  postGitPull,
  postGitPush,
} from "@/api/resources";
import type { ActionRequest, DomainActionName, GitWriteRequest } from "@/api/types";

export const queryKeys = {
  tasks: ["tasks"] as const,
  issues: ["issues"] as const,
  ideas: ["ideas"] as const,
  events: (entityType?: string, entityId?: string) => ["events", entityType ?? "all", entityId ?? "all"] as const,
  members: ["members"] as const,
  settings: ["settings"] as const,
  capabilities: ["capabilities"] as const,
  materials: ["materials"] as const,
  design: ["design"] as const,
  gitStatus: ["git", "status"] as const,
  gitLog: ["git", "log"] as const,
  gitDiff: (commit?: string) => ["git", "diff", commit ?? "worktree"] as const,
};

export function useTasksQuery() {
  return useQuery({ queryKey: queryKeys.tasks, queryFn: listTasks });
}
export function useIssuesQuery() {
  return useQuery({ queryKey: queryKeys.issues, queryFn: listIssues });
}
export function useIdeasQuery() {
  return useQuery({ queryKey: queryKeys.ideas, queryFn: listIdeas });
}
export function useEventsQuery(entityType?: string, entityId?: string) {
  return useQuery({
    queryKey: queryKeys.events(entityType, entityId),
    queryFn: () => listEvents({ entityType, entityId }),
  });
}
export function useMembersQuery() {
  return useQuery({ queryKey: queryKeys.members, queryFn: listMembers });
}
export function useSettingsQuery() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: getSettings });
}
export function useCapabilitiesQuery() {
  return useQuery({ queryKey: queryKeys.capabilities, queryFn: getCapabilities });
}
export function useMaterialsQuery() {
  return useQuery({ queryKey: queryKeys.materials, queryFn: getMaterials });
}
export function useDesignQuery() {
  return useQuery({ queryKey: queryKeys.design, queryFn: getDesign });
}
export function useGitStatusQuery() {
  return useQuery({ queryKey: queryKeys.gitStatus, queryFn: getGitStatus, retry: false });
}
export function useGitLogQuery() {
  return useQuery({ queryKey: queryKeys.gitLog, queryFn: getGitLog });
}
export function useGitDiffQuery(commit?: string) {
  return useQuery({ queryKey: queryKeys.gitDiff(commit), queryFn: () => getGitDiff({ commit }) });
}

export function useDomainAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, request }: { action: DomainActionName; request: ActionRequest }) =>
      postAction(action, request),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["issues"] });
      void qc.invalidateQueries({ queryKey: ["ideas"] });
      void qc.invalidateQueries({ queryKey: ["events"] });
      void qc.invalidateQueries({ queryKey: ["members"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["git"] });
    },
  });
}

export function useGitFetchMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postGitFetch,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["git"] }),
  });
}

export function useGitPullMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GitWriteRequest) => postGitPull(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["git"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["issues"] });
      void qc.invalidateQueries({ queryKey: ["ideas"] });
      void qc.invalidateQueries({ queryKey: ["events"] });
    },
  });
}

export function useGitCommitMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GitWriteRequest) => postGitCommit(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["git"] }),
  });
}

export function useGitPushMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GitWriteRequest) => postGitPush(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["git"] }),
  });
}
