import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = await mkdtemp(path.join(os.tmpdir(), 'nuedc-safe-git-cli-'));
const remote = path.join(root, 'remote.git');
const seed = path.join(root, 'seed');
const clone = path.join(root, 'clone');
const script = path.resolve('scripts/git-safe.mjs');

function run(command, args, cwd = root, expect = 0) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== expect) {
    throw new Error(
      `${command} ${args.join(' ')} 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return (result.stdout || '').trim();
}

try {
  run('git', ['init', '--bare', remote]);
  run('git', ['clone', remote, seed]);
  run('git', ['config', 'user.name', 'seed'], seed);
  run('git', ['config', 'user.email', 'seed@example.test'], seed);
  await writeFile(path.join(seed, 'README.md'), '# test\n', 'utf8');
  run('git', ['add', 'README.md'], seed);
  run('git', ['commit', '-m', 'init'], seed);
  run('git', ['branch', '-M', 'main'], seed);
  run('git', ['push', 'origin', 'HEAD:main'], seed);
  run('git', ['clone', remote, clone]);
  run('git', ['config', 'user.name', 'teammate'], clone);
  run('git', ['config', 'user.email', 'teammate@example.test'], clone);

  const before = run('git', ['rev-parse', 'HEAD'], clone);
  run('node', [script, 'pull', '--repo', clone, '--dry-run']);
  run('node', [script, 'push', '--repo', clone, '--dry-run']);

  await writeFile(path.join(clone, 'local.txt'), 'local change\n', 'utf8');
  run('node', [
    script,
    'commit',
    '--repo',
    clone,
    '--message',
    'test: dry run',
    '--dry-run',
  ]);

  const after = run('git', ['rev-parse', 'HEAD'], clone);
  const status = run('git', ['status', '--porcelain'], clone);
  if (before !== after) throw new Error('dry-run 不应改变 HEAD');
  if (status !== '?? local.txt') throw new Error(`dry-run 不应暂存或提交文件，实际状态：${status}`);
  console.log('safe-git-cli-smoke: pass');
} finally {
  await rm(root, { recursive: true, force: true });
}
