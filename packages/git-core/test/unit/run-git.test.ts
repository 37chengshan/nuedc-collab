import { describe, expect, it } from 'vitest';
import { buildGitInvocation } from '../../src/index.js';

describe('buildGitInvocation', () => {
  it('fetch 只有固定参数且关闭 shell', () => {
    const invocation = buildGitInvocation('fetch');
    expect(invocation.args).toEqual(['fetch', '--prune', 'origin']);
    expect(invocation.options.shell).toBe(false);
    expect(invocation.options.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('push 固定 origin HEAD:main', () => {
    const invocation = buildGitInvocation('push');
    expect(invocation.args).toEqual(['push', 'origin', 'HEAD:main']);
    expect(invocation.options.shell).toBe(false);
  });

  it('merge 只允许 --ff-only origin/main', () => {
    const invocation = buildGitInvocation('mergeFfOnly');
    expect(invocation.args).toEqual(['merge', '--ff-only', 'origin/main']);
  });
});
