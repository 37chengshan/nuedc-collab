import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProtocolRuntime } from "@nuedc/protocol";
import { ensureLocalIdentity } from "../src/identity.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("本机 GitHub 身份初始化", () => {
  it("首次启动自动写入检测到的 GitHub username", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nuedc-identity-"));
    roots.push(root);
    const runtime = await createProtocolRuntime(root);

    const settings = await ensureLocalIdentity(runtime.repository, async () => "teammate-a");

    expect(settings).toMatchObject({
      githubUsername: "teammate-a",
      confirmGitWrites: true,
    });
    await expect(runtime.repository.readLocalSettings()).resolves.toMatchObject({
      githubUsername: "teammate-a",
    });
  });

  it("已有本机设置时不调用检测器也不覆盖", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nuedc-identity-"));
    roots.push(root);
    const runtime = await createProtocolRuntime(root);
    await runtime.repository.writeLocalSettings({
      schemaVersion: 1,
      githubUsername: "existing-user",
      port: 4321,
      autoFetchIntervalSeconds: 120,
      motionLevel: "reduced",
      confirmGitWrites: true,
    });
    let called = false;

    const settings = await ensureLocalIdentity(runtime.repository, async () => {
      called = true;
      return "other-user";
    });

    expect(called).toBe(false);
    expect(settings?.githubUsername).toBe("existing-user");
    expect(settings?.port).toBe(4321);
  });

  it("无法识别时保持未配置，不伪造成员身份", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nuedc-identity-"));
    roots.push(root);
    const runtime = await createProtocolRuntime(root);

    await expect(ensureLocalIdentity(runtime.repository, async () => null)).resolves.toBeNull();
    await expect(runtime.repository.readLocalSettings()).rejects.toThrow("本机设置不存在");
  });
});
