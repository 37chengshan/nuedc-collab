import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getGitStatus, getSettings, postGitFetch } from "@/api/resources";
import { useGitMonitorPause } from "@/features/git/GitWizardContext";
import { queryKeys } from "@/hooks/queries";

export function useGitStatus(options?: { refetchInterval?: number | false }) {
  const paused = useGitMonitorPause();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: getSettings,
    staleTime: 30_000,
    retry: false,
  });
  const intervalSeconds = settingsQuery.data?.data.autoFetchIntervalSeconds ?? 60;
  const autoFetchInterval =
    options?.refetchInterval === false || paused
      ? false
      : options?.refetchInterval ?? Math.max(30, intervalSeconds) * 1000;

  const query = useQuery({
    queryKey: queryKeys.gitStatus,
    queryFn: getGitStatus,
    retry: false,
  });

  useEffect(() => {
    if (autoFetchInterval === false) return;
    let active = true;
    const timer = window.setInterval(() => {
      void postGitFetch()
        .then((result) => {
          if (active) queryClient.setQueryData(queryKeys.gitStatus, result.state);
        })
        .catch(() => {
          // 保留最后一次可信状态；手动“检查”会展示具体错误。
        });
    }, autoFetchInterval);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [autoFetchInterval, queryClient]);

  return query;
}
