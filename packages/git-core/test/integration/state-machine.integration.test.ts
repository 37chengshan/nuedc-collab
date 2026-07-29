import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitFixture } from './git-fixture.js';

describe('git state machine integration', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = new GitFixture();
    await fixture.setup();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it.each([
    'clean',
    'dirty',
    'ahead',
    'behind',
    'diverged',
    'conflict',
    'noRemote',
    'unborn',
  ] as const)('构造并识别 %s 本地或拓扑状态', async (expected) => {
    const core = await fixture.coreForState(expected);
    const state = await core.inspect();
    if (expected === 'clean') {
      expect(state).toMatchObject({ worktree: 'clean', topology: 'synced' });
    } else if (expected === 'dirty') {
      expect(state.worktree).toBe('dirty');
    } else if (expected === 'conflict') {
      expect(state.worktree).toBe('conflict');
    } else if (expected === 'unborn') {
      expect(state.topology).toBe('unborn');
    } else if (expected === 'noRemote') {
      expect(state.topology).toBe('noRemote');
    } else {
      expect(state.topology).toBe(expected);
    }
  });

  it('本机 HTTP 401 remote 映射为 authError 与 GIT_AUTH_ERROR', async () => {
    const core = await fixture.coreWithUnauthorizedRemote();
    await expect(core.fetch()).rejects.toMatchObject({ code: 'GIT_AUTH_ERROR' });
    expect((await core.inspect()).connection).toBe('authError');
  });

  it('网络不可达 remote 映射为 networkError', async () => {
    const core = await fixture.coreWithUnreachableRemote();
    await expect(core.fetch()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const state = await core.inspect();
    expect(state.connection).toBe('networkError');
  });
});
