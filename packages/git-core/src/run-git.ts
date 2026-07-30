import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  GitError,
  type GitInvocation,
  type GitOperationName,
} from './types.js';

const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const LOCAL_TIMEOUT_MS = 10_000;
const NETWORK_TIMEOUT_MS = 30_000;

const FORBIDDEN_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
];

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (FORBIDDEN_ENV.includes(key)) continue;
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return env;
}

function ensureEmptyHooksDir(repoRoot: string): string {
  const hooksDir = join(repoRoot, '.看板缓存', 'git-hooks-empty');
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }
  return hooksDir;
}

export function buildGitInvocation(
  operation: GitOperationName,
  extraArgs: string[] = [],
): GitInvocation {
  const env = baseEnv();
  let args: string[];
  let timeoutMs = LOCAL_TIMEOUT_MS;

  switch (operation) {
    case 'status':
      args = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
      break;
    case 'revParseHead':
      args = ['rev-parse', 'HEAD'];
      break;
    case 'revParseRemote':
      args = ['rev-parse', 'origin/main'];
      break;
    case 'revList':
      args = ['rev-list', '--left-right', '--count', 'HEAD...origin/main'];
      break;
    case 'log':
      args = [
        'log',
        '--max-count=50',
        '--date=iso-strict',
        '--pretty=format:%H%x09%h%x09%an%x09%ae%x09%aI%x09%P%x09%s',
      ];
      break;
    case 'diff':
      args = ['diff', '--no-ext-diff', '--no-color', '--find-renames'];
      break;
    case 'diffCached':
      args = ['diff', '--cached', '--name-status', '-z'];
      break;
    case 'lsFiles':
      args = ['ls-files', '--stage', '-z', '--'];
      break;
    case 'hashObject':
      args = ['hash-object'];
      break;
    case 'fetch':
      args = ['fetch', '--prune', 'origin'];
      timeoutMs = NETWORK_TIMEOUT_MS;
      break;
    case 'mergeFfOnly':
      args = ['merge', '--ff-only', 'origin/main'];
      break;
    case 'add':
      args = ['add', '--'];
      break;
    case 'commit':
      args = ['commit', '-m'];
      break;
    case 'push':
      args = ['push', 'origin', 'HEAD:main'];
      timeoutMs = NETWORK_TIMEOUT_MS;
      break;
    case 'show':
      args = ['show', '--no-color', '--format=medium'];
      break;
    case 'symbolicRef':
      args = ['symbolic-ref', '--quiet', 'HEAD'];
      break;
    default: {
      const _exhaustive: never = operation;
      throw new GitError('INVALID_GIT_REQUEST', `未知 Git 操作: ${String(_exhaustive)}`);
    }
  }

  if (extraArgs.length > 0) {
    // Only append caller-controlled path/message args after fixed templates.
    args = [...args, ...extraArgs];
  }

  return {
    args,
    options: {
      shell: false,
      env,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    },
  };
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function classifyAuthOrNetwork(stderr: string, stdout: string, err?: NodeJS.ErrnoException): GitError | null {
  const blob = `${stderr}\n${stdout}`;
  if (
    /Authentication failed/i.test(blob) ||
    /HTTP\s*401/i.test(blob) ||
    /could not read Username/i.test(blob) ||
    /unable to get (?:username|password) from user/i.test(blob) ||
    /terminal prompts disabled/i.test(blob) ||
    /Invalid username or password/i.test(blob) ||
    /Permission denied \(publickey\)/i.test(blob) ||
    /Repository not found/i.test(blob)
  ) {
    return new GitError(
      'GIT_AUTH_ERROR',
      'GitHub 身份验证失败，未执行远端操作。',
      redactSecrets(blob).slice(0, 500),
    );
  }
  if (
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ENOTFOUND' ||
    err?.code === 'EAI_AGAIN' ||
    err?.code === 'ETIMEDOUT' ||
    /Could not resolve host/i.test(blob) ||
    /Failed to connect/i.test(blob) ||
    /Connection refused/i.test(blob) ||
    /Network is unreachable/i.test(blob) ||
    /timed out/i.test(blob)
  ) {
    return new GitError(
      'NETWORK_ERROR',
      '无法连接远端仓库，未执行远端操作。',
      redactSecrets(blob).slice(0, 500),
    );
  }
  return null;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/https?:\/\/[^\s:@]+:[^\s@]+@/gi, 'https://***:***@')
    .replace(/(token|password|secret|authorization)=([^\s&]+)/gi, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
}

export async function runGit(
  repoRoot: string,
  operation: GitOperationName,
  extraArgs: string[] = [],
  options?: { allowFailure?: boolean },
): Promise<RunGitResult> {
  const invocation = buildGitInvocation(operation, extraArgs);
  const hooksDir = ensureEmptyHooksDir(repoRoot);
  const env = {
    ...invocation.options.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksDir,
  };

  return await new Promise<RunGitResult>((resolve, reject) => {
    const child = spawn('git', invocation.args, {
      cwd: repoRoot,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, invocation.options.timeoutMs);

    const onChunk = (which: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') {
        stdoutBytes += chunk.length;
        if (stdoutBytes > invocation.options.maxOutputBytes) {
          child.kill('SIGKILL');
          return;
        }
        stdout += text;
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes > invocation.options.maxOutputBytes) {
          child.kill('SIGKILL');
          return;
        }
        stderr += text;
      }
    };

    child.stdout?.on('data', (c: Buffer) => onChunk('stdout', c));
    child.stderr?.on('data', (c: Buffer) => onChunk('stderr', c));

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const classified = classifyAuthOrNetwork(stderr, stdout, err);
      reject(classified ?? new GitError('GIT_COMMAND_FAILED', `无法启动 git：${err.message}`, redactSecrets(err.message)));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (
        stdoutBytes > invocation.options.maxOutputBytes ||
        stderrBytes > invocation.options.maxOutputBytes
      ) {
        reject(new GitError('GIT_OUTPUT_TOO_LARGE', 'Git 输出超过 1 MiB 上限，已中止。'));
        return;
      }

      if (timedOut) {
        const classified = classifyAuthOrNetwork(stderr, stdout);
        reject(
          classified ??
            new GitError(
              operation === 'fetch' || operation === 'push' ? 'NETWORK_ERROR' : 'GIT_COMMAND_FAILED',
              'Git 命令超时。',
              redactSecrets(`${stdout}\n${stderr}`).slice(0, 500),
            ),
        );
        return;
      }

      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        const classified = classifyAuthOrNetwork(stderr, stdout);
        if (classified) {
          reject(classified);
          return;
        }
        if (options?.allowFailure) {
          resolve({ stdout, stderr, exitCode });
          return;
        }
        reject(
          new GitError(
            'GIT_COMMAND_FAILED',
            `git ${invocation.args.join(' ')} 失败（退出码 ${exitCode}）。`,
            redactSecrets(`${stdout}\n${stderr}`).slice(0, 800),
          ),
        );
        return;
      }

      resolve({ stdout, stderr, exitCode });
    });
  });
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
