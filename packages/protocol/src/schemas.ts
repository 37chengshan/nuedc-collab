import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type {
  DomainActionName,
  DomainActionRequest,
  Event,
  Idea,
  Issue,
  LocalSettings,
  Member,
  Task,
} from './types.js';

const addFormats = addFormatsModule as unknown as (instance: Ajv) => Ajv;

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
addFormats(ajv);

const isoDateTime = {
  type: 'string' as const,
  format: 'date-time',
};

const githubUsername = {
  type: 'string' as const,
  pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$',
  minLength: 1,
  maxLength: 39,
};

const moduleName = {
  type: 'string' as const,
  minLength: 1,
  maxLength: 64,
  pattern: '^\\S(?:.*\\S)?$',
};

const taskId = { type: 'string' as const, pattern: '^T-\\d{8}-[0-9A-HJKMNP-TV-Z]{4}$' };
const issueId = { type: 'string' as const, pattern: '^I-\\d{8}-[0-9A-HJKMNP-TV-Z]{4}$' };
const ideaId = { type: 'string' as const, pattern: '^A-\\d{8}-[0-9A-HJKMNP-TV-Z]{4}$' };
const eventId = {
  type: 'string' as const,
  pattern: '^E-\\d{8}-\\d{6}-[0-9A-HJKMNP-TV-Z]{4}$',
};
const commitSha = { type: 'string' as const, pattern: '^[0-9a-f]{7,40}$' };
const revision = { type: 'string' as const, pattern: '^[0-9a-f]{64}$' };
const idempotencyKey = {
  type: 'string' as const,
  pattern: '^[A-Za-z0-9._:-]{16,128}$',
};

export const taskSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'recordType',
    'schemaVersion',
    'id',
    'title',
    'module',
    'status',
    'priority',
    'participants',
    'dependencies',
    'blockingIssueIds',
    'relatedCommits',
    'description',
    'acceptanceCriteria',
    'completedAcceptanceCriteria',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    recordType: { const: 'task' },
    schemaVersion: { const: 1 },
    id: taskId,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    module: moduleName,
    status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'review', 'done'] },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    owner: githubUsername,
    participants: { type: 'array', items: githubUsername, uniqueItems: true },
    dependencies: { type: 'array', items: taskId, uniqueItems: true },
    blockingIssueIds: { type: 'array', items: issueId, uniqueItems: true },
    relatedCommits: { type: 'array', items: commitSha, uniqueItems: true },
    description: { type: 'string', maxLength: 4000 },
    acceptanceCriteria: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, uniqueItems: true },
    completedAcceptanceCriteria: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 500 },
      uniqueItems: true,
    },
    sourceIdeaId: ideaId,
    dueAt: isoDateTime,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  },
} as const;

export const issueSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'recordType',
    'schemaVersion',
    'id',
    'title',
    'status',
    'severity',
    'blocking',
    'linkedTaskIds',
    'symptoms',
    'workaround',
    'resolution',
    'relatedCommits',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    recordType: { const: 'issue' },
    schemaVersion: { const: 1 },
    id: issueId,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    status: { type: 'string', enum: ['open', 'investigating', 'blocked', 'resolved'] },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    owner: githubUsername,
    blocking: { type: 'boolean' },
    linkedTaskIds: { type: 'array', items: taskId, uniqueItems: true },
    symptoms: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 } },
    workaround: { type: 'string', maxLength: 2000 },
    resolution: { type: 'string', maxLength: 2000 },
    relatedCommits: { type: 'array', items: commitSha, uniqueItems: true },
    description: { type: 'string', maxLength: 4000 },
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  },
} as const;

export const ideaSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'recordType',
    'schemaVersion',
    'id',
    'title',
    'status',
    'author',
    'module',
    'description',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    recordType: { const: 'idea' },
    schemaVersion: { const: 1 },
    id: ideaId,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    status: { type: 'string', enum: ['open', 'discarded'] },
    author: githubUsername,
    owner: githubUsername,
    module: moduleName,
    description: { type: 'string', maxLength: 4000 },
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  },
} as const;

export const eventSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'recordType',
    'schemaVersion',
    'id',
    'entityType',
    'entityId',
    'kind',
    'actor',
    'message',
    'createdAt',
  ],
  properties: {
    recordType: { const: 'event' },
    schemaVersion: { const: 1 },
    id: eventId,
    entityType: { type: 'string', enum: ['task', 'issue', 'idea'] },
    entityId: { type: 'string', minLength: 1 },
    kind: {
      type: 'string',
      enum: ['comment', 'progress', 'statusChange', 'handoff', 'decision', 'testResult'],
    },
    actor: githubUsername,
    message: { type: 'string', minLength: 1, maxLength: 4000 },
    relatedCommit: commitSha,
    supersedesEventId: eventId,
    createdAt: isoDateTime,
  },
} as const;

export const memberSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'recordType',
    'schemaVersion',
    'githubUsername',
    'roles',
    'responsibilities',
    'status',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    recordType: { const: 'member' },
    schemaVersion: { const: 1 },
    githubUsername,
    roles: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: [
          'coordinator',
          'hardware',
          'firmware',
          'vision',
          'mechanical',
          'testing',
          'documentation',
        ],
      },
    },
    responsibilities: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 } },
    status: { type: 'string', enum: ['active', 'inactive'] },
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  },
} as const;

export const localSettingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'githubUsername',
    'port',
    'autoFetchIntervalSeconds',
    'motionLevel',
    'confirmGitWrites',
  ],
  properties: {
    schemaVersion: { const: 1 },
    githubUsername,
    port: { type: 'integer', minimum: 1024, maximum: 65535 },
    autoFetchIntervalSeconds: { type: 'integer', minimum: 30, maximum: 600 },
    motionLevel: { type: 'string', enum: ['system', 'none', 'reduced', 'standard'] },
    confirmGitWrites: { const: true },
  },
} as const;

export const materialMetadataSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'title',
    'type',
    'source',
    'pinnedVersion',
    'modules',
    'verificationStatus',
    'license',
    'notes',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', minLength: 1, maxLength: 64 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    type: {
      type: 'string',
      enum: ['notice', 'hardware', 'tutorial', 'external-repo', 'other'],
    },
    source: { type: 'string', minLength: 1, maxLength: 500 },
    pinnedVersion: { type: 'string', minLength: 1, maxLength: 120 },
    modules: { type: 'array', items: moduleName },
    verificationStatus: {
      type: 'string',
      enum: ['unverified', 'reviewed', 'approved', 'rejected'],
    },
    license: { type: 'string', maxLength: 200 },
    notes: { type: 'string', maxLength: 2000 },
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  },
} as const;

export const systemCanvasSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'title', 'phase', 'nodes', 'edges', 'context', 'updatedAt'],
  properties: {
    schemaVersion: { const: 1 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    phase: { type: 'string', enum: ['赛前准备', '赛题分析', '方案设计', '实现验证'] },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'status'],
        properties: {
          id: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
          status: { type: 'string', minLength: 1 },
          module: moduleName,
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'label'],
        properties: {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
        },
      },
    },
    context: {
      type: 'object',
      additionalProperties: false,
      required: ['linkedIssueIds', 'linkedEventIds', 'linkedMaterialIds'],
      properties: {
        linkedIssueIds: { type: 'array', items: issueId },
        linkedEventIds: { type: 'array', items: eventId },
        linkedMaterialIds: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    updatedAt: isoDateTime,
  },
} as const;

function actionEnvelope(payloadSchema: object, requiresRevision: boolean) {
  const properties: Record<string, object> = {
    idempotencyKey,
    payload: payloadSchema,
  };
  const required = ['idempotencyKey', 'payload'];
  if (requiresRevision) {
    properties.expectedRevision = revision;
    required.push('expectedRevision');
  } else {
    properties.expectedRevision = revision;
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  } as const;
}

const taskCreatePayload = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'module', 'priority'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    module: moduleName,
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    owner: githubUsername,
    description: { type: 'string', maxLength: 4000 },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 500 },
      uniqueItems: true,
    },
    dueAt: isoDateTime,
    participants: { type: 'array', items: githubUsername, uniqueItems: true },
    dependencies: { type: 'array', items: taskId, uniqueItems: true },
    blockingIssueIds: { type: 'array', items: issueId, uniqueItems: true },
  },
} as const;

const taskUpdatePayload = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: taskId,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    module: moduleName,
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    owner: githubUsername,
    description: { type: 'string', maxLength: 4000 },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 500 },
      uniqueItems: true,
    },
    completedAcceptanceCriteria: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 500 },
      uniqueItems: true,
    },
    dueAt: isoDateTime,
    participants: { type: 'array', items: githubUsername, uniqueItems: true },
    dependencies: { type: 'array', items: taskId, uniqueItems: true },
    blockingIssueIds: { type: 'array', items: issueId, uniqueItems: true },
    relatedCommits: { type: 'array', items: commitSha, uniqueItems: true },
  },
} as const;

const taskSetStatusPayload = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'to'],
  properties: {
    id: taskId,
    to: { type: 'string', enum: ['todo', 'doing', 'blocked', 'review', 'done'] },
    message: { type: 'string', minLength: 1, maxLength: 4000 },
  },
} as const;

const taskHandoffPayload = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'toOwner'],
  properties: {
    id: taskId,
    toOwner: githubUsername,
    message: { type: 'string', minLength: 1, maxLength: 4000 },
  },
} as const;

const issueCreatePayload = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'severity', 'blocking'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    blocking: { type: 'boolean' },
    owner: githubUsername,
    symptoms: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 } },
    workaround: { type: 'string', maxLength: 2000 },
    description: { type: 'string', maxLength: 4000 },
    linkedTaskIds: { type: 'array', items: taskId, uniqueItems: true },
  },
} as const;

const issueUpdatePayload = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: issueId,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    status: { type: 'string', enum: ['open', 'investigating', 'blocked', 'resolved'] },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    owner: githubUsername,
    blocking: { type: 'boolean' },
    symptoms: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 } },
    workaround: { type: 'string', maxLength: 2000 },
    resolution: { type: 'string', maxLength: 2000 },
    description: { type: 'string', maxLength: 4000 },
    linkedTaskIds: { type: 'array', items: taskId, uniqueItems: true },
    relatedCommits: { type: 'array', items: commitSha, uniqueItems: true },
  },
} as const;

const issueHandoffPayload = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'toOwner'],
  properties: {
    id: issueId,
    toOwner: githubUsername,
    message: { type: 'string', minLength: 1, maxLength: 4000 },
  },
} as const;

const eventAppendPayload = {
  type: 'object',
  additionalProperties: false,
  required: ['entityType', 'entityId', 'kind', 'message'],
  properties: {
    entityType: { type: 'string', enum: ['task', 'issue', 'idea'] },
    entityId: { type: 'string', minLength: 1 },
    kind: {
      type: 'string',
      enum: ['comment', 'progress', 'statusChange', 'handoff', 'decision', 'testResult'],
    },
    message: { type: 'string', minLength: 1, maxLength: 4000 },
    relatedCommit: commitSha,
    supersedesEventId: eventId,
  },
} as const;

const ideaCreatePayload = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'module'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    module: moduleName,
    description: { type: 'string', maxLength: 4000 },
    owner: githubUsername,
  },
} as const;

const ideaUpdatePayload = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: ideaId,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    status: { type: 'string', enum: ['open', 'discarded'] },
    module: moduleName,
    description: { type: 'string', maxLength: 4000 },
    owner: githubUsername,
  },
} as const;

const ideaPromotePayload = {
  type: 'object',
  additionalProperties: false,
  required: ['ideaId', 'title', 'module', 'priority'],
  properties: {
    ideaId: ideaId,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    module: moduleName,
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    owner: githubUsername,
    description: { type: 'string', maxLength: 4000 },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 500 },
      uniqueItems: true,
    },
  },
} as const;

const memberUpdatePayload = {
  type: 'object',
  additionalProperties: false,
  required: ['githubUsername'],
  properties: {
    githubUsername,
    roles: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: [
          'coordinator',
          'hardware',
          'firmware',
          'vision',
          'mechanical',
          'testing',
          'documentation',
        ],
      },
    },
    responsibilities: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 } },
    status: { type: 'string', enum: ['active', 'inactive'] },
  },
} as const;

const settingsUpdatePayload = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    githubUsername,
    port: { type: 'integer', minimum: 1024, maximum: 65535 },
    autoFetchIntervalSeconds: { type: 'integer', minimum: 30, maximum: 600 },
    motionLevel: { type: 'string', enum: ['system', 'none', 'reduced', 'standard'] },
  },
} as const;

export const actionSchemas: Record<DomainActionName, object> = {
  'task.create': actionEnvelope(taskCreatePayload, false),
  'task.update': actionEnvelope(taskUpdatePayload, true),
  'task.setStatus': actionEnvelope(taskSetStatusPayload, true),
  'task.handoff': actionEnvelope(taskHandoffPayload, true),
  'issue.create': actionEnvelope(issueCreatePayload, false),
  'issue.update': actionEnvelope(issueUpdatePayload, true),
  'issue.handoff': actionEnvelope(issueHandoffPayload, true),
  'event.append': actionEnvelope(eventAppendPayload, false),
  'idea.create': actionEnvelope(ideaCreatePayload, false),
  'idea.update': actionEnvelope(ideaUpdatePayload, true),
  'idea.promoteToTask': actionEnvelope(ideaPromotePayload, true),
  'member.update': actionEnvelope(memberUpdatePayload, true),
  'settings.update': actionEnvelope(settingsUpdatePayload, false),
};

const validators = {
  task: ajv.compile(taskSchema),
  issue: ajv.compile(issueSchema),
  idea: ajv.compile(ideaSchema),
  event: ajv.compile(eventSchema),
  member: ajv.compile(memberSchema),
  localSettings: ajv.compile(localSettingsSchema),
  materialMetadata: ajv.compile(materialMetadataSchema),
  systemCanvas: ajv.compile(systemCanvasSchema),
};

const actionValidators = Object.fromEntries(
  Object.entries(actionSchemas).map(([name, schema]) => [name, ajv.compile(schema)]),
) as Record<DomainActionName, ReturnType<typeof ajv.compile>>;

export function formatAjvErrors(
  errors: readonly ErrorObject[] | null | undefined,
): string {
  if (!errors || errors.length === 0) return '校验失败';
  return errors
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`.trim())
    .join('; ');
}

export function validateTask(data: unknown): data is Task {
  return Boolean(validators.task(data));
}
export function validateIssue(data: unknown): data is Issue {
  return Boolean(validators.issue(data));
}
export function validateIdea(data: unknown): data is Idea {
  return Boolean(validators.idea(data));
}
export function validateEvent(data: unknown): data is Event {
  return Boolean(validators.event(data));
}
export function validateMember(data: unknown): data is Member {
  return Boolean(validators.member(data));
}
export function validateLocalSettings(data: unknown): data is LocalSettings {
  return Boolean(validators.localSettings(data));
}

export function getValidationError(kind: keyof typeof validators, data: unknown): string | null {
  const ok = validators[kind](data);
  if (ok) return null;
  return formatAjvErrors(validators[kind].errors);
}

export function getActionSchema(action: DomainActionName): object {
  return actionSchemas[action];
}

export function validateActionRequest(
  action: DomainActionName,
  request: unknown,
): { ok: true; value: DomainActionRequest } | { ok: false; message: string } {
  const validator = actionValidators[action];
  if (!validator) {
    return { ok: false, message: `不支持的动作: ${action}` };
  }
  if (!validator(request)) {
    return { ok: false, message: formatAjvErrors(validator.errors) };
  }
  return { ok: true, value: request as DomainActionRequest };
}

export const DOMAIN_ACTIONS: DomainActionName[] = [
  'task.create',
  'task.update',
  'task.setStatus',
  'task.handoff',
  'issue.create',
  'issue.update',
  'issue.handoff',
  'event.append',
  'idea.create',
  'idea.update',
  'idea.promoteToTask',
  'member.update',
  'settings.update',
];
