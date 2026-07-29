import { useQuery } from "@tanstack/react-query";
import { getGitStatus, getSettings } from "@/api/resources";
import { useGitMonitorPause } from "@/features/git/GitWizardContext";

export function useGitStatus(options?: { refetchInterval?: number | false }) {
  const paused = useGitMonitorPause();
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    staleTime: 30_000,
    retry: false,
  });
  const intervalSeconds = settingsQuery.data?.data.autoFetchIntervalSeconds ?? 60;
  const refetchInterval =
    options?.refetchInterval === false || paused
      ? false
      : options?.refetchInterval ?? Math.max(30, intervalSeconds) * 1000;

  return useQuery({
    queryKey: ["git-status"],
    queryFn: getGitStatus,
    refetchInterval,
    retry: false,
  });
}
