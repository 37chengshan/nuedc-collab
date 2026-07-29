import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'CLAUDE.md');
const target = path.join(root, 'AGENTS.md');
const content = await readFile(source, 'utf8');
await writeFile(target, content, 'utf8');
console.log('已将 CLAUDE.md 同步到 AGENTS.md');
