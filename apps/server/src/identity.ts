import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalSettings, ProtocolRepository } from "@nuedc/protocol";

const execFileAsync = promisify(execFile);
const GITHUB_USERNAME = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

function normalizeUsername(value: string | undefined | null): string | null {
  const username = value?.trim();
  return username && GITHUB_USERNAME.test(username) ? username : null;
}

async function commandOutput(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 4_000,
      maxBuffer: 64 * 1024,
      env: process.env,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function detectGithubUsername(): Promise<string | null> {
  const fromEnvironment =
    normalizeUsername(process.env.GH_USER) ??
    normalizeUsername(process.env.GITHUB_USER) ??
    normalizeUsername(process.env.GITHUB_ACTOR);
  if (fromEnvironment) return fromEnvironment;

  const fromGithubCli = normalizeUsername(await commandOutput("gh", ["api", "user", "--jq", ".login"]));
  if (fromGithubCli) return fromGithubCli;

  const fromGitConfig = normalizeUsername(await commandOutput("git", ["config", "--get", "github.user"]));
  if (fromGitConfig) return fromGitConfig;

  const email = await commandOutput("git", ["config", "--get", "user.email"]);
  const noreplyMatch = email?.match(/^([^@+]+)(?:\+[^@]+)?@users\.noreply\.github\.com$/i);
  const fromNoreplyEmail = normalizeUsername(noreplyMatch?.[1]);
  if (fromNoreplyEmail) return fromNoreplyEmail;

  return normalizeUsername(await commandOutput("git", ["config", "--get", "user.name"]));
}

export async function ensureLocalIdentity(
  repository: ProtocolRepository,
  detector: () => Promise<string | null> = detectGithubUsername,
): Promise<LocalSettings | null> {
  try {
    return await repository.readLocalSettings();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("本机设置不存在")) throw error;
  }

  const githubUsername = await detector();
  if (!githubUsername) return null;

  const settings: LocalSettings = {
    schemaVersion: 1,
    githubUsername,
    port: 3210,
    autoFetchIntervalSeconds: 60,
    motionLevel: "system",
    confirmGitWrites: true,
  };
  await repository.writeLocalSettings(settings);
  return settings;
}
