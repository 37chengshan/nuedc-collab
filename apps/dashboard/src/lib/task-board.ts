import type { TaskBoardColumn, TaskRecord, TaskStatus } from '@/api/types';

export function statusToColumn(status: TaskStatus): TaskBoardColumn {
  if (status === 'blocked' || status === 'doing') return 'doing';
  if (status === 'review') return 'review';
  if (status === 'done') return 'done';
  return 'todo';
}

export function columnToDefaultStatus(column: TaskBoardColumn): TaskStatus {
  if (column === 'doing') return 'doing';
  if (column === 'review') return 'review';
  if (column === 'done') return 'done';
  return 'todo';
}

export const BOARD_COLUMNS: Array<{ id: TaskBoardColumn; title: string }> = [
  { id: 'todo', title: '待开始' },
  { id: 'doing', title: '进行中' },
  { id: 'review', title: '待验证' },
  { id: 'done', title: '已完成' },
];

export function groupTasks(tasks: TaskRecord[]): Record<TaskBoardColumn, TaskRecord[]> {
  const groups: Record<TaskBoardColumn, TaskRecord[]> = {
    todo: [],
    doing: [],
    review: [],
    done: [],
  };
  for (const task of tasks) {
    groups[statusToColumn(task.status)].push(task);
  }
  return groups;
}
