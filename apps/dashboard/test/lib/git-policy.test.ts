import { describe, expect, it } from "vitest";
import { canCommit, canPull, canPush } from "@/lib/git-policy";
import type { GitState } from "@/api/types";

const base: GitState = {
  worktree: "clean",
  topology: "synced",
  connection: "online",
  head: "1".repeat(40),
  remoteHead: "1".repeat(40),
  ahead: 0,
  behind: 0,
  severity: "clean",
  lastCheckedAt: "2026-07-29T10:00:00+08:00",
};

describe("git policy", () => {
  it("只允许 clean + behind 拉取", () => {
    expect(canPull({ ...base, topology: "behind", behind: 1 }).allowed).toBe(true);
    expect(canPull({ ...base, worktree: "dirty", topology: "behind", behind: 1 }).allowed).toBe(false);
  });

  it("冲突时禁止全部写操作", () => {
    const conflict = { ...base, worktree: "conflict", topology: "diverged", severity: "conflict" } as GitState;
    expect(canPull(conflict).allowed).toBe(false);
    expect(canCommit(conflict).allowed).toBe(false);
    expect(canPush(conflict).allowed).toBe(false);
  });
});
