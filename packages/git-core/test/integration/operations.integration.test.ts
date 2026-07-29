import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitFixture } from './git-fixture.js';

describe('git operations integration', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = new GitFixture();
    await fixture.setup();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('过期确认不改变 HEAD 或 index', async () => {
    fixture.write('cloneA', 'notes.txt', 'before confirmation\n');
    const request = await fixture.commitRequest('cloneA');
    fixture.write('cloneA', 'notes.txt', 'changed after confirmation\n');
    const beforeHead = fixture.head('cloneA');
    await expect(fixture.core('cloneA').commitSelected(request)).rejects.toMatchObject({
      code: 'STALE_GIT_STATE',
    });
    expect(fixture.head('cloneA')).toBe(beforeHead);
  });

  it('已有暂存内容返回 PREEXISTING_STAGED_CHANGES', async () => {
    fixture.stage('cloneA', 'already-staged.txt');
    // also create an unstaged extra file so commitRequest has selectable changes besides staged? staged file is a change too.
    // commitRequest will include staged file; commitSelected should reject due to preexisting staged.
    await expect(
      fixture.core('cloneA').commitSelected(await fixture.commitRequest('cloneA')),
    ).rejects.toMatchObject({ code: 'PREEXISTING_STAGED_CHANGES' });
  });

  it('clean behind 可以快进拉取', async () => {
    fixture.write('cloneA', 'from-a.txt', 'a\n');
    fixture.commitDirect('cloneA', 'from a', ['from-a.txt']);
    fixture.pushDirect('cloneA');

    fixture.fetchDirect('cloneB');
    const core = fixture.core('cloneB');
    const state = await core.inspect();
    expect(state.topology).toBe('behind');
    const result = await core.pullFastForward({
      expectedHead: state.head!,
      expectedRemoteHead: state.remoteHead!,
      confirmed: true,
    });
    expect(result.ok).toBe(true);
    expect((await core.inspect()).topology).toBe('synced');
  });

  it('ahead 可以提交后推送', async () => {
    fixture.write('cloneA', 'push-me.txt', 'push\n');
    const request = await fixture.commitRequest('cloneA');
    const committed = await fixture.core('cloneA').commitSelected(request);
    expect(committed.ok).toBe(true);
    const state = await fixture.core('cloneA').inspect();
    expect(state.topology).toBe('ahead');
    const pushed = await fixture.core('cloneA').push({
      expectedHead: state.head!,
      expectedRemoteHead: state.remoteHead!,
      confirmed: true,
    });
    expect(pushed.ok).toBe(true);
    expect((await fixture.core('cloneA').inspect()).topology).toBe('synced');
  });

  it('dirty 禁止拉取', async () => {
    fixture.write('cloneA', 'remote-adv.txt', 'r\n');
    fixture.commitDirect('cloneA', 'adv', ['remote-adv.txt']);
    fixture.pushDirect('cloneA');
    fixture.fetchDirect('cloneB');
    fixture.write('cloneB', 'local-dirty.txt', 'dirty\n');
    const core = fixture.core('cloneB');
    const state = await core.inspect();
    await expect(
      core.pullFastForward({
        expectedHead: state.head!,
        expectedRemoteHead: state.remoteHead!,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
  });
});
