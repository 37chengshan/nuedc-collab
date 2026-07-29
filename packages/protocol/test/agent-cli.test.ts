import { describe, expect, it } from 'vitest';
import { DOMAIN_ACTIONS } from '../src/index.js';

describe('agent capability contract', () => {
  it('公开恰好 13 个可重复领域动作且不包含 Git 写操作', () => {
    expect(DOMAIN_ACTIONS).toHaveLength(13);
    expect(new Set(DOMAIN_ACTIONS).size).toBe(13);
    expect(DOMAIN_ACTIONS.some((action) => action.startsWith('git.'))).toBe(false);
  });
});
