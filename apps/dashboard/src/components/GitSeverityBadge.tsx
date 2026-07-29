import type { GitState } from "@/api/types";
import { Badge, type BadgeTone } from "./Badge";

const LABELS: Record<GitState['severity'], string> = {
  conflict: '冲突',
  unborn: '尚无提交',
  noRemote: '无远端',
  networkError: '网络错误',
  authError: '认证失败',
  diverged: '已分叉',
  behind: '落后远端',
  ahead: '领先远端',
  dirty: '有改动',
  clean: '已同步',
};

const TONES: Record<GitState['severity'], BadgeTone> = {
  conflict: 'danger',
  unborn: 'warning',
  noRemote: 'warning',
  networkError: 'danger',
  authError: 'danger',
  diverged: 'danger',
  behind: 'info',
  ahead: 'orange',
  dirty: 'warning',
  clean: 'success',
};

export function GitSeverityBadge({ severity }: { severity: GitState['severity'] }) {
  return <Badge tone={TONES[severity]}>{LABELS[severity]}</Badge>;
}
