export function formatRelativeTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return '未知时间';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  if (abs < 60) return rtf.format(diff, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(t).toLocaleString('zh-CN');
}

export function shortHash(hash?: string | null, len = 7): string {
  if (!hash) return '—';
  return hash.slice(0, len);
}

const TASK_STATUS: Record<string, string> = {
  todo: '待开始',
  doing: '进行中',
  blocked: '阻塞',
  review: '待验证',
  done: '已完成',
};

const ISSUE_STATUS: Record<string, string> = {
  open: '开放',
  investigating: '排查中',
  blocked: '阻塞',
  resolved: '已解决',
};

const IDEA_STATUS: Record<string, string> = {
  open: '开放',
  discarded: '已拒绝',
  converted: '已转任务',
};

const PRIORITY: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '紧急',
};

export function labelTaskStatus(status: string): string {
  return TASK_STATUS[status] || status;
}
export function labelIssueStatus(status: string): string {
  return ISSUE_STATUS[status] || status;
}
export function labelIdeaStatus(status: string): string {
  return IDEA_STATUS[status] || status;
}
export function labelPriority(priority: string): string {
  return PRIORITY[priority] || priority;
}

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
