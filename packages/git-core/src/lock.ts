const locks = new Map<string, Promise<unknown>>();

export class AsyncGitLock {
  static async run<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(repoRoot) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => gate);
    locks.set(repoRoot, current);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(repoRoot) === current) {
        locks.delete(repoRoot);
      }
    }
  }
}
