import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGitCore, hashSelectedChanges, type CommitRequest, type GitCore, type GitState } from '../../src/index.js';

export type CloneName = 'cloneA' | 'cloneB' | 'cloneC';
export type ConstructableState =
  | 'clean'
  | 'dirty'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'conflict'
  | 'noRemote'
  | 'unborn';

function run(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

export class GitFixture {
  root: string;
  remote: string;
  clones: Record<CloneName, string>;
  private authServer: Server | null = null;
  private authPort: number | null = null;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'nuedc-git-core-'));
    this.remote = join(this.root, 'remote.git');
    this.clones = {
      cloneA: join(this.root, 'cloneA'),
      cloneB: join(this.root, 'cloneB'),
      cloneC: join(this.root, 'cloneC'),
    };
  }

  async setup(): Promise<void> {
    run(this.root, ['init', '--bare', this.remote]);
    // seed initial commit via temporary work clone
    const seed = join(this.root, 'seed');
    run(this.root, ['clone', this.remote, seed]);
    this.configIdentity(seed, 'seed');
    writeFileSync(join(seed, 'README.md'), '# nuedc collab\n');
    run(seed, ['add', 'README.md']);
    run(seed, ['commit', '-m', 'init']);
    run(seed, ['branch', '-M', 'main']);
    run(seed, ['push', 'origin', 'HEAD:main']);
    run(this.remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    for (const name of Object.keys(this.clones) as CloneName[]) {
      run(this.root, ['clone', this.remote, this.clones[name]]);
      this.configIdentity(this.clones[name], name);
    }
  }

  configIdentity(repo: string, name: string): void {
    run(repo, ['config', 'user.name', name]);
    run(repo, ['config', 'user.email', `${name}@example.test`]);
  }

  async cleanup(): Promise<void> {
    if (this.authServer) {
      await new Promise<void>((resolve) => this.authServer!.close(() => resolve()));
      this.authServer = null;
    }
    rmSync(this.root, { recursive: true, force: true });
  }

  path(name: CloneName): string {
    return this.clones[name];
  }

  core(name: CloneName | string): GitCore {
    const repoRoot = typeof name === 'string' && name in this.clones ? this.clones[name as CloneName] : String(name);
    return createGitCore({ repoRoot });
  }

  head(name: CloneName): string {
    return run(this.clones[name], ['rev-parse', 'HEAD']);
  }

  remoteHead(): string {
    return run(this.remote, ['rev-parse', 'refs/heads/main']);
  }

  write(name: CloneName, relativePath: string, content: string): void {
    const abs = join(this.clones[name], relativePath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }

  stage(name: CloneName, relativePath: string, content = 'staged\n'): void {
    this.write(name, relativePath, content);
    run(this.clones[name], ['add', '--', relativePath]);
  }

  commitDirect(name: CloneName, message: string, files?: string[]): string {
    if (files) {
      run(this.clones[name], ['add', '--', ...files]);
    } else {
      run(this.clones[name], ['add', '-A']);
    }
    run(this.clones[name], ['commit', '-m', message]);
    return this.head(name);
  }

  pushDirect(name: CloneName): void {
    run(this.clones[name], ['push', 'origin', 'HEAD:main']);
  }

  fetchDirect(name: CloneName): void {
    run(this.clones[name], ['fetch', '--prune', 'origin']);
  }

  async commitRequest(name: CloneName, files?: string[]): Promise<CommitRequest> {
    const core = this.core(name);
    const state = await core.inspect();
    const changes = await core.listChanges();
    const selected = files
      ? changes.filter((c) => files.includes(c.path))
      : changes;
    if (selected.length === 0) {
      throw new Error('no changes for commitRequest');
    }
    return {
      files: selected.map((c) => c.path),
      message: 'test commit',
      expectedHead: state.head ?? 'UNBORN',
      expectedChangesHash: hashSelectedChanges(selected),
      confirmed: true,
    };
  }

  async coreForState(expected: ConstructableState): Promise<GitCore> {
    // Always start from a fresh cloneA-like workspace under state dir
    const dir = join(this.root, `state-${expected}`);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

    if (expected === 'unborn') {
      mkdirSync(dir, { recursive: true });
      run(dir, ['init']);
      this.configIdentity(dir, 'unborn');
      // no commit, optionally no remote
      return createGitCore({ repoRoot: dir });
    }

    run(this.root, ['clone', this.remote, dir]);
    this.configIdentity(dir, expected);

    if (expected === 'noRemote') {
      run(dir, ['remote', 'remove', 'origin']);
      return createGitCore({ repoRoot: dir });
    }

    if (expected === 'clean') {
      return createGitCore({ repoRoot: dir });
    }

    if (expected === 'dirty') {
      writeFileSync(join(dir, 'dirty.txt'), 'dirty\n');
      return createGitCore({ repoRoot: dir });
    }

    if (expected === 'ahead') {
      writeFileSync(join(dir, 'ahead.txt'), 'ahead\n');
      run(dir, ['add', 'ahead.txt']);
      run(dir, ['commit', '-m', 'ahead']);
      return createGitCore({ repoRoot: dir });
    }

    if (expected === 'behind') {
      // advance remote via cloneA
      this.write('cloneA', 'behind-remote.txt', 'from remote\n');
      this.commitDirect('cloneA', 'remote advance', ['behind-remote.txt']);
      this.pushDirect('cloneA');
      run(dir, ['fetch', '--prune', 'origin']);
      return createGitCore({ repoRoot: dir });
    }

    if (expected === 'diverged') {
      // local unique commit
      writeFileSync(join(dir, 'local.txt'), 'local\n');
      run(dir, ['add', 'local.txt']);
      run(dir, ['commit', '-m', 'local']);
      // remote unique commit
      this.write('cloneA', 'remote-only.txt', 'remote\n');
      this.commitDirect('cloneA', 'remote only', ['remote-only.txt']);
      this.pushDirect('cloneA');
      run(dir, ['fetch', '--prune', 'origin']);
      return createGitCore({ repoRoot: dir });
    }

    if (expected === 'conflict') {
      // create conflict by overlapping edits with merge
      writeFileSync(join(dir, 'conflict.txt'), 'base\n');
      run(dir, ['add', 'conflict.txt']);
      run(dir, ['commit', '-m', 'conflict base']);
      run(dir, ['push', 'origin', 'HEAD:main']);

      // branch simulation: update remote differently using cloneA after fetch
      this.fetchDirect('cloneA');
      run(this.clones.cloneA, ['pull', '--ff-only', 'origin', 'main']);
      this.write('cloneA', 'conflict.txt', 'remote side\n');
      this.commitDirect('cloneA', 'remote conflict', ['conflict.txt']);
      this.pushDirect('cloneA');

      // local different edit
      writeFileSync(join(dir, 'conflict.txt'), 'local side\n');
      run(dir, ['add', 'conflict.txt']);
      run(dir, ['commit', '-m', 'local conflict']);
      run(dir, ['fetch', '--prune', 'origin']);
      // force a conflicted merge state
      const merge = spawnSync('git', ['merge', '--no-commit', '--no-ff', 'origin/main'], {
        cwd: dir,
        encoding: 'utf8',
        shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      void merge;
      return createGitCore({ repoRoot: dir });
    }

    throw new Error(`unknown state ${expected}`);
  }

  async coreWithUnauthorizedRemote(): Promise<GitCore> {
    if (!this.authServer) {
      this.authServer = createServer((req, res) => {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="Git"');
        res.end('Unauthorized');
      });
      await new Promise<void>((resolve) => {
        this.authServer!.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = this.authServer.address();
      if (!addr || typeof addr === 'string') throw new Error('auth server address missing');
      this.authPort = addr.port;
    }
    const dir = join(this.root, 'auth-clone');
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    // clone from real remote first then repoint origin
    run(this.root, ['clone', this.remote, dir]);
    this.configIdentity(dir, 'auth');
    run(dir, ['config', 'credential.helper', '']);
    run(dir, ['config', 'credential.interactive', 'never']);
    run(dir, ['remote', 'set-url', 'origin', `http://127.0.0.1:${this.authPort}/repo.git`]);
    return createGitCore({ repoRoot: dir });
  }

  async coreWithUnreachableRemote(): Promise<GitCore> {
    // bind and close a port to get a free port that will refuse connections
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const addr = probe.address();
    if (!addr || typeof addr === 'string') throw new Error('probe address missing');
    const port = addr.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const dir = join(this.root, 'net-clone');
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    run(this.root, ['clone', this.remote, dir]);
    this.configIdentity(dir, 'net');
    run(dir, ['remote', 'set-url', 'origin', `http://127.0.0.1:${port}/repo.git`]);
    return createGitCore({ repoRoot: dir });
  }
}

export async function withFixture<T>(fn: (fixture: GitFixture) => Promise<T>): Promise<T> {
  const fixture = new GitFixture();
  await fixture.setup();
  try {
    return await fn(fixture);
  } finally {
    await fixture.cleanup();
  }
}
