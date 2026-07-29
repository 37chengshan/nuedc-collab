export type NavGroup = '协作' | '证据' | '设置';

export interface NavItem {
  path: string;
  label: string;
  group: NavGroup;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '工作台', group: '协作', description: '仓库脉搏、今日事项与协作摘要' },
  { path: '/tasks', label: '任务', group: '协作', description: '四列看板与负责人流转' },
  { path: '/issues', label: '问题', group: '协作', description: '严重度、症状与阻塞跟踪' },
  { path: '/ideas', label: '想法', group: '协作', description: '探索与提升为任务' },
  { path: '/history', label: '提交历史', group: '证据', description: '提交时间线与只读 diff' },
  { path: '/materials', label: '参考资料', group: '证据', description: '教程、硬件与外部仓库索引' },
  { path: '/design', label: '总体设计', group: '证据', description: '方案文档与系统画布' },
  { path: '/settings', label: '设置', group: '设置', description: '本机身份、同步与 Agent 能力映射' },
];

export function navItemForPath(pathname: string): NavItem {
  const exact = NAV_ITEMS.find((item) => item.path === pathname);
  if (exact) return exact;
  const prefix = NAV_ITEMS
    .filter((item) => item.path !== '/' && pathname.startsWith(item.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return prefix ?? NAV_ITEMS[0]!;
}

export function isNavActive(pathname: string, path: string): boolean {
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(`${path}/`);
}
