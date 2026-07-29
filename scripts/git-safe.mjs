#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import {
  GitError,
  createGitCore,
  hashSelectedChanges,
} from '../packages/git-core/dist/index.js';
import { createProtocolRuntime } from '../packages/protocol/dist/index.js';

function parse(argv) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [key, inline] = token.split('=', 2);
    if (inline !== undefined) {
      options.set(key, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { positional, options };
}

function option(options, key) {
  const value = options.get(key);
  return typeof value === 'string' ? value : undefined;
}

function printState(state) {
  console.log(`分支：${state.branch ?? '未知'}`);
  console.log(`工作区：${state.worktree}；拓扑：${state.topology}；连接：${state.connection}`);
  console.log(`本地 HEAD：${state.head ?? '无'}；远端 HEAD：${state.remoteHead ?? '无'}`);
  console.log(`领先 ${state.ahead} 个提交，落后 ${state.behind} 个提交`);
  if (state.dirtyPaths.length) console.log(`改动文件：\n- ${state.dirtyPaths.join('\n- ')}`);
  if (state.conflictPaths.length) console.log(`冲突文件：\n- ${state.conflictPaths.join('\n- ')}`);
}

async function confirm(expected, description, options) {
  console.log(`\n将执行：${description}`);
  console.log(`确认短语：${expected}`);
  if (options.has('--dry-run')) {
    console.log('dry-run：未执行任何写操作。');
    return false;
  }
  const supplied = option(options, '--confirm');
  if (supplied !== undefined) return supplied === expected;
  if (!process.stdin.isTTY) {
    console.log('非交互环境未提供 --confirm，已安全停止。');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('请输入确认短语：');
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

function guidance(error) {
  const code = error instanceof GitError ? error.code : 'UNKNOWN';
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n已停止：${message}`);
  if (code === 'CONFLICT_PRESENT' || code === 'DIVERGED_HISTORY') {
    console.error(`中文处理指引：
1. 不要继续 pull、push，也不要使用 force、reset --hard 或自动 rebase。
2. 先备份当前目录，或执行：git diff > ../电赛冲突备份.patch
3. 执行 git status，记录冲突/分叉文件并联系队友确认谁的改动保留。
4. 对冲突文件逐个手工合并，确认无 <<<<<<<、=======、>>>>>>> 标记。
5. 运行 npm run validate 和相关测试，再重新走安全提交与推送。`);
  } else if (code === 'DIRTY_WORKTREE' || code === 'PREEXISTING_STAGED_CHANGES') {
    console.error('请先用 npm run git:status 查看改动；完成或撤销自己的改动后再拉取。不要用 reset --hard。');
  } else if (code === 'NO_REMOTE') {
    console.error('请先由熟悉 Git 的成员配置 origin，并确认默认分支为 main。');
  } else if (code === 'GIT_AUTH_ERROR') {
    console.error('请检查 GitHub 登录/SSH Key；不要把 Token 写进仓库文件。');
  } else if (code === 'NETWORK_ERROR') {
    console.error('请检查网络，稍后重试；本地文件未被修改。');
  }
  process.exitCode = 1;
}

async function validateJson(repoRoot) {
  const runtime = await createProtocolRuntime(repoRoot);
  const results = await Promise.all([
    runtime.repository.listTasks(),
    runtime.repository.listIssues(),
    runtime.repository.listIdeas(),
    runtime.repository.listEvents(),
    runtime.repository.listMembers(),
  ]);
  const invalid = results.flatMap((result) => result.invalidFiles);
  if (invalid.length) {
    throw new Error(`JSON 校验失败：\n${invalid.map((item) => `- ${item.path}: ${item.error}`).join('\n')}`);
  }
}

async function main() {
  const { positional, options } = parse(process.argv.slice(2));
  const command = positional[0] ?? 'help';
  const repoRoot = path.resolve(option(options, '--repo') ?? process.cwd());
  const core = createGitCore({ repoRoot });

  if (command === 'help' || options.has('--help')) {
    console.log(`安全 Git 协作脚本

用法：
  npm run git:status
  npm run git:pull -- [--dry-run] [--confirm 确认获取|确认拉取]
  npm run git:commit -- --message "提交说明" [--files a,b] [--dry-run] [--confirm 确认提交]
  npm run git:push -- [--dry-run] [--confirm 确认推送]

规则：禁止 force push、reset --hard、自动解决冲突；状态变化后确认立即失效。`);
    return;
  }

  if (command === 'status') {
    printState(await core.inspect());
    const changes = await core.listChanges();
    const commits = await core.listLog(10);
    console.log('\n当前改动：');
    console.log(changes.length ? changes.map((item) => `- ${item.status} ${item.path}`).join('\n') : '无');
    console.log('\n最近提交：');
    console.log(commits.length ? commits.map((item) => `- ${item.shortSha} ${item.subject}`).join('\n') : '无');
    return;
  }

  if (command === 'pull') {
    let state = await core.inspect();
    printState(state);
    if (state.worktree === 'conflict') throw new GitError('CONFLICT_PRESENT', '拉取前已存在冲突。');
    if (state.worktree !== 'clean') throw new GitError('DIRTY_WORKTREE', '拉取前工作区必须干净。');
    if (!(await confirm('确认获取', 'git fetch --prune origin（只更新远端跟踪信息）', options))) {
      console.log('未确认获取，已停止。');
      return;
    }
    state = await core.fetch();
    printState(state);
    if (state.topology === 'synced') {
      console.log('已经是最新版本，无需拉取。');
      return;
    }
    if (state.topology !== 'behind' || !state.head || !state.remoteHead) {
      throw new GitError(
        state.topology === 'diverged' ? 'DIVERGED_HISTORY' : 'INVALID_GIT_REQUEST',
        `当前状态 ${state.topology} 不允许自动拉取。`,
      );
    }
    if (!(await confirm('确认拉取', 'git merge --ff-only origin/main（仅允许快进）', options))) {
      console.log('未确认拉取，已停止。');
      return;
    }
    const result = await core.pullFastForward({
      expectedHead: state.head,
      expectedRemoteHead: state.remoteHead,
      confirmed: true,
    });
    console.log(result.message);
    printState(result.state);
    return;
  }

  if (command === 'commit') {
    const message = option(options, '--message');
    if (!message) throw new GitError('INVALID_GIT_REQUEST', '必须填写 --message 提交说明。');
    await validateJson(repoRoot);
    const state = await core.inspect();
    const allChanges = await core.listChanges();
    const requested = option(options, '--files')?.split(',').map((item) => item.trim()).filter(Boolean);
    const selected = requested?.length
      ? allChanges.filter((item) => requested.includes(item.path))
      : allChanges;
    if (!selected.length) throw new GitError('INVALID_GIT_REQUEST', '没有可提交的改动。');
    printState(state);
    console.log('\n即将提交：');
    console.log(selected.map((item) => `- ${item.status} ${item.path}`).join('\n'));
    const diffs = await core.readDiff();
    const patchLines = diffs.reduce((sum, item) => sum + (item.patch?.split('\n').length ?? 0), 0);
    console.log(`Diff 摘要：${diffs.length} 个文件，约 ${patchLines} 行补丁；提交说明：${message}`);
    if (!(await confirm('确认提交', `git add -- <所选文件> && git commit -m ${JSON.stringify(message)}`, options))) {
      console.log('未确认提交，已停止。');
      return;
    }
    const result = await core.commitSelected({
      files: selected.map((item) => item.path),
      message,
      expectedHead: state.head ?? 'UNBORN',
      expectedChangesHash: hashSelectedChanges(selected),
      confirmed: true,
    });
    console.log(`${result.message}：${result.commit}`);
    return;
  }

  if (command === 'push') {
    const state = await core.inspect();
    printState(state);
    const commits = await core.listLog(Math.max(state.ahead, 1));
    console.log('\n即将推送的本地提交：');
    console.log(commits.slice(0, state.ahead).map((item) => `- ${item.shortSha} ${item.subject}`).join('\n') || '无');
    if (!state.head || !state.remoteHead) throw new GitError('NO_REMOTE', '缺少本地或远端 HEAD。');
    if (!(await confirm('确认推送', 'git fetch --prune origin，复核后 git push origin HEAD:main', options))) {
      console.log('未确认推送，已停止。');
      return;
    }
    const result = await core.push({
      expectedHead: state.head,
      expectedRemoteHead: state.remoteHead,
      confirmed: true,
    });
    console.log(result.message);
    printState(result.state);
    return;
  }

  throw new GitError('INVALID_GIT_REQUEST', `未知命令：${command}`);
}

main().catch(guidance);
