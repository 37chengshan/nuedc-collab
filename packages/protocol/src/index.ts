import path from 'node:path';
import { createDomainActionService } from './actions.js';
import { createProtocolRepository, DomainRecordStore } from './repository.js';
import type { ProtocolRuntime } from './types.js';

export * from './types.js';
export * from './schemas.js';
export * from './ids.js';
export * from './paths.js';
export * from './json.js';
export * from './fs.js';
export * from './references.js';
export { createProtocolRepository, DomainRecordStore, envelope } from './repository.js';
export { createDomainActionService } from './actions.js';

export async function createProtocolRuntime(repoRoot: string): Promise<ProtocolRuntime> {
  const root = path.resolve(repoRoot);
  const store = new DomainRecordStore(root);
  await store.ensureStructure();
  const repository = await createProtocolRepository(root);
  const actions = createDomainActionService(root, store);
  return { repository, actions };
}
