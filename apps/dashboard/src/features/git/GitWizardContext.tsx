import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { GitWizardKind } from "@/api/types";
import { GitConfirmWizard } from "./GitConfirmWizard";

interface GitWizardContextValue {
  openWizard: (kind: GitWizardKind) => void;
  closeWizard: () => void;
  paused: boolean;
}

const GitWizardContext = createContext<GitWizardContextValue>({
  openWizard: () => undefined,
  closeWizard: () => undefined,
  paused: false,
});

export function GitWizardProvider({ children }: { children: ReactNode }) {
  const [kind, setKind] = useState<GitWizardKind | null>(null);
  const openWizard = useCallback((next: GitWizardKind) => setKind(next), []);
  const closeWizard = useCallback(() => setKind(null), []);
  const value = useMemo(
    () => ({ openWizard, closeWizard, paused: kind !== null }),
    [openWizard, closeWizard, kind],
  );
  return (
    <GitWizardContext.Provider value={value}>
      {children}
      {kind ? <GitConfirmWizard kind={kind} open onClose={closeWizard} /> : null}
    </GitWizardContext.Provider>
  );
}

export function useGitWizard() {
  return useContext(GitWizardContext);
}

export function useGitMonitorPause() {
  return useContext(GitWizardContext).paused;
}
