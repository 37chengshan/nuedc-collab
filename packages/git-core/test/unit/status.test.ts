import { describe, expect, it } from 'vitest';
import { getSeverity } from '../../src/index.js';

describe('getSeverity', () => {
  it('认证失败的严重级别高于分叉', () => {
    expect(
      getSeverity({
        worktree: 'clean',
        topology: 'diverged',
        connection: 'authError',
      }),
    ).toBe('authError');
  });

  it('conflict 高于一切', () => {
    expect(
      getSeverity({
        worktree: 'conflict',
        topology: 'behind',
        connection: 'online',
      }),
    ).toBe('conflict');
  });

  it('unborn 高于 noRemote', () => {
    expect(
      getSeverity({
        worktree: 'clean',
        topology: 'unborn',
        connection: 'online',
      }),
    ).toBe('unborn');
  });

  it('dirty 低于 ahead', () => {
    expect(
      getSeverity({
        worktree: 'dirty',
        topology: 'ahead',
        connection: 'online',
      }),
    ).toBe('ahead');
  });
});
