import { describe, expect, it } from 'vitest';
import { hashSelectedChanges } from '../../src/index.js';

describe('hashSelectedChanges', () => {
  it('选中文件摘要绑定路径、状态和内容哈希', () => {
    expect(
      hashSelectedChanges([
        {
          path: '比赛管理/任务/T-20260728-A3F2.json',
          status: 'M',
          contentHash: 'a'.repeat(64),
        },
        {
          path: '比赛管理/问题/I-20260728-91BC.json',
          status: 'D',
          contentHash: 'DELETED',
        },
      ]),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('顺序不影响哈希', () => {
    const a = hashSelectedChanges([
      { path: 'b.txt', status: 'M', contentHash: '1'.repeat(64) },
      { path: 'a.txt', status: 'A', contentHash: '2'.repeat(64) },
    ]);
    const b = hashSelectedChanges([
      { path: 'a.txt', status: 'A', contentHash: '2'.repeat(64) },
      { path: 'b.txt', status: 'M', contentHash: '1'.repeat(64) },
    ]);
    expect(a).toBe(b);
  });
});
