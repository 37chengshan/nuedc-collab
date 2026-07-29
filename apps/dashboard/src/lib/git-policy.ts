import type { GitState } from '@/api/types';

export function canPull(state: GitState): { allowed: boolean; reason?: string } {
  if (state.connection === 'networkError') return { allowed: false, reason: '网络不可用，无法拉取。' };
  if (state.connection === 'authError') return { allowed: false, reason: 'GitHub 身份验证失败，请使用系统凭据管理器重新登录。' };
  if (state.topology === 'noRemote') return { allowed: false, reason: '尚未配置 origin/main。' };
  if (state.topology === 'unborn') return { allowed: false, reason: '仓库尚无首次提交。' };
  if (state.worktree === 'dirty') return { allowed: false, reason: '工作区有未提交改动，请先提交或清理后再拉取。' };
  if (state.worktree === 'conflict') return { allowed: false, reason: '存在冲突，请人工解决后再操作。' };
  if (state.topology === 'diverged') return { allowed: false, reason: '本地与远端已分叉，禁止自动拉取。' };
  if (state.topology !== 'behind') return { allowed: false, reason: '当前不落后于远端，无需拉取。' };
  return { allowed: true };
}

export function canCommit(state: GitState): { allowed: boolean; reason?: string } {
  if (state.worktree === 'conflict') return { allowed: false, reason: '存在冲突，请先解决冲突文件。' };
  if (state.worktree === 'clean' && state.topology !== 'unborn') {
    return { allowed: false, reason: '工作区干净，没有可提交的改动。' };
  }
  return { allowed: true };
}

export function canPush(state: GitState): { allowed: boolean; reason?: string } {
  if (state.connection === 'networkError') return { allowed: false, reason: '网络不可用，无法推送。' };
  if (state.connection === 'authError') return { allowed: false, reason: 'GitHub 身份验证失败。' };
  if (state.topology === 'noRemote') return { allowed: false, reason: '尚未配置 origin/main。' };
  if (state.topology === 'unborn') return { allowed: false, reason: '尚无本地提交可推送。' };
  if (state.worktree === 'dirty') return { allowed: false, reason: '工作区不干净，请先提交。' };
  if (state.worktree === 'conflict') return { allowed: false, reason: '存在冲突，禁止推送。' };
  if (state.topology === 'behind' || state.topology === 'diverged') {
    return { allowed: false, reason: '远端领先或历史分叉，请先处理后再推送。' };
  }
  if (state.topology !== 'ahead') return { allowed: false, reason: '本地没有超前提交。' };
  return { allowed: true };
}
