import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  eventSchema,
  ideaSchema,
  issueSchema,
  localSettingsSchema,
  memberSchema,
  taskSchema,
} from '../packages/protocol/dist/index.js';

const target = path.resolve('比赛管理/Schema');
await mkdir(target, { recursive: true });
const schemas = {
  task: taskSchema,
  issue: issueSchema,
  idea: ideaSchema,
  event: eventSchema,
  member: memberSchema,
  'local-settings': localSettingsSchema,
};
for (const [name, schema] of Object.entries(schemas)) {
  await writeFile(
    path.join(target, `${name}.schema.json`),
    `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema }, null, 2)}\n`,
    'utf8',
  );
}
console.log(`已导出 ${Object.keys(schemas).length} 个 Schema 到 比赛管理/Schema`);
