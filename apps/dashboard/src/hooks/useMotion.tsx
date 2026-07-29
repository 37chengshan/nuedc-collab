import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSettings } from "@/api/resources";
import { durationMs, resolveMotionLevel, type ResolvedMotion } from "@/lib/motion";

interface MotionContextValue {
  level: ResolvedMotion;
  setting: "system" | "none" | "reduced" | "standard";
  duration: (kind: "press" | "hover" | "toast" | "menu" | "drawer" | "page") => number;
}

const MotionContext = createContext<MotionContextValue>({
  level: "standard",
  setting: "system",
  duration: (kind) => durationMs(kind, "standard"),
});

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function MotionProvider({ children }: { children: ReactNode }) {
  const prefersReduced = usePrefersReducedMotion();
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    staleTime: 30_000,
    retry: false,
  });
  const setting = settingsQuery.data?.data.motionLevel ?? "system";
  const level = resolveMotionLevel(setting, prefersReduced);

  useEffect(() => {
    document.documentElement.dataset.motion = level;
  }, [level]);

  const value = useMemo<MotionContextValue>(
    () => ({
      level,
      setting,
      duration: (kind) => durationMs(kind, level),
    }),
    [level, setting],
  );

  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotion() {
  return useContext(MotionContext);
}
