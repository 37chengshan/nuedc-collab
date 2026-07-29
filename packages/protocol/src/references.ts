import type {
  Event,
  Idea,
  Issue,
  Member,
  ProtocolWarning,
  Task,
} from './types.js';
import { isEventId, isIdeaId, isIssueId, isTaskId } from './ids.js';

export interface ReferenceSnapshot {
  tasks: Map<string, Task>;
  issues: Map<string, Issue>;
  ideas: Map<string, Idea>;
  events: Map<string, Event>;
  members: Map<string, Member>;
}

export interface ReferenceValidation {
  errors: string[];
  warnings: ProtocolWarning[];
}

export function emptySnapshot(): ReferenceSnapshot {
  return {
    tasks: new Map(),
    issues: new Map(),
    ideas: new Map(),
    events: new Map(),
    members: new Map(),
  };
}

function warnMissing(
  warnings: ProtocolWarning[],
  code: string,
  id: string,
  message: string,
): void {
  warnings.push({ code, id, message });
}

export function validateTaskReferences(
  task: Task,
  snapshot: ReferenceSnapshot,
): ReferenceValidation {
  const errors: string[] = [];
  const warnings: ProtocolWarning[] = [];

  if (task.dependencies.includes(task.id)) {
    errors.push(`任务 ${task.id} 不能依赖自身`);
  }
  for (const dep of task.dependencies) {
    if (!isTaskId(dep)) {
      errors.push(`非法任务依赖 ID: ${dep}`);
      continue;
    }
    if (!snapshot.tasks.has(dep)) {
      warnMissing(warnings, 'MISSING_TASK_REF', dep, `依赖任务尚未同步: ${dep}`);
    }
  }
  for (const issueId of task.blockingIssueIds) {
    if (!isIssueId(issueId)) {
      errors.push(`非法阻塞问题 ID: ${issueId}`);
      continue;
    }
    if (!snapshot.issues.has(issueId)) {
      warnMissing(warnings, 'MISSING_ISSUE_REF', issueId, `阻塞问题尚未同步: ${issueId}`);
    }
  }
  if (task.sourceIdeaId) {
    if (!isIdeaId(task.sourceIdeaId)) {
      errors.push(`非法来源想法 ID: ${task.sourceIdeaId}`);
    } else if (!snapshot.ideas.has(task.sourceIdeaId)) {
      warnMissing(
        warnings,
        'MISSING_IDEA_REF',
        task.sourceIdeaId,
        `来源想法尚未同步: ${task.sourceIdeaId}`,
      );
    }
  }
  for (const completed of task.completedAcceptanceCriteria) {
    if (!task.acceptanceCriteria.includes(completed)) {
      errors.push(`已完成验收项必须存在于 acceptanceCriteria: ${completed}`);
    }
  }
  if (task.owner && !snapshot.members.has(task.owner)) {
    warnMissing(warnings, 'MISSING_MEMBER_REF', task.owner, `负责人成员尚未同步: ${task.owner}`);
  }
  return { errors, warnings };
}

export function validateIssueReferences(
  issue: Issue,
  snapshot: ReferenceSnapshot,
): ReferenceValidation {
  const errors: string[] = [];
  const warnings: ProtocolWarning[] = [];
  for (const taskId of issue.linkedTaskIds) {
    if (!isTaskId(taskId)) {
      errors.push(`非法关联任务 ID: ${taskId}`);
      continue;
    }
    if (!snapshot.tasks.has(taskId)) {
      warnMissing(warnings, 'MISSING_TASK_REF', taskId, `关联任务尚未同步: ${taskId}`);
    }
  }
  if (issue.owner && !snapshot.members.has(issue.owner)) {
    warnMissing(warnings, 'MISSING_MEMBER_REF', issue.owner, `负责人成员尚未同步: ${issue.owner}`);
  }
  return { errors, warnings };
}

export function validateIdeaReferences(
  idea: Idea,
  snapshot: ReferenceSnapshot,
): ReferenceValidation {
  const errors: string[] = [];
  const warnings: ProtocolWarning[] = [];
  if (!snapshot.members.has(idea.author)) {
    warnMissing(warnings, 'MISSING_MEMBER_REF', idea.author, `作者成员尚未同步: ${idea.author}`);
  }
  if (idea.owner && !snapshot.members.has(idea.owner)) {
    warnMissing(warnings, 'MISSING_MEMBER_REF', idea.owner, `负责人成员尚未同步: ${idea.owner}`);
  }
  return { errors, warnings };
}

export function validateEventReferences(
  event: Event,
  snapshot: ReferenceSnapshot,
): ReferenceValidation {
  const errors: string[] = [];
  const warnings: ProtocolWarning[] = [];
  if (event.entityType === 'task') {
    if (!isTaskId(event.entityId)) errors.push(`事件实体 ID 非法: ${event.entityId}`);
    else if (!snapshot.tasks.has(event.entityId)) {
      warnMissing(warnings, 'MISSING_TASK_REF', event.entityId, `事件关联任务尚未同步: ${event.entityId}`);
    }
  } else if (event.entityType === 'issue') {
    if (!isIssueId(event.entityId)) errors.push(`事件实体 ID 非法: ${event.entityId}`);
    else if (!snapshot.issues.has(event.entityId)) {
      warnMissing(warnings, 'MISSING_ISSUE_REF', event.entityId, `事件关联问题尚未同步: ${event.entityId}`);
    }
  } else if (event.entityType === 'idea') {
    if (!isIdeaId(event.entityId)) errors.push(`事件实体 ID 非法: ${event.entityId}`);
    else if (!snapshot.ideas.has(event.entityId)) {
      warnMissing(warnings, 'MISSING_IDEA_REF', event.entityId, `事件关联想法尚未同步: ${event.entityId}`);
    }
  }
  if (event.supersedesEventId) {
    if (!isEventId(event.supersedesEventId)) {
      errors.push(`非法 supersedesEventId: ${event.supersedesEventId}`);
    } else if (!snapshot.events.has(event.supersedesEventId)) {
      warnMissing(
        warnings,
        'MISSING_EVENT_REF',
        event.supersedesEventId,
        `被修正事件尚未同步: ${event.supersedesEventId}`,
      );
    }
  }
  if (!snapshot.members.has(event.actor)) {
    warnMissing(warnings, 'MISSING_MEMBER_REF', event.actor, `事件 actor 成员尚未同步: ${event.actor}`);
  }
  return { errors, warnings };
}

export function detectTaskDependencyCycle(snapshot: ReferenceSnapshot): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const errors: string[] = [];

  function dfs(id: string, stack: string[]): void {
    if (visiting.has(id)) {
      errors.push(`检测到任务依赖环: ${[...stack, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const task = snapshot.tasks.get(id);
    if (task) {
      for (const dep of task.dependencies) {
        if (snapshot.tasks.has(dep)) dfs(dep, [...stack, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of snapshot.tasks.keys()) dfs(id, []);
  return errors;
}
