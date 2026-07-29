#!/usr/bin/env node
import { gzipSync } from "node:zlib";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import process from "node:process";

const budgetKiB = Number(process.env.FIRST_SCREEN_JS_BUDGET_KIB || 250);
const outputDir = resolve(process.cwd(), process.env.DASHBOARD_DIST_DIR || "apps/dashboard/dist");
const indexPath = resolve(outputDir, "index.html");

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function filesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(path) : [path];
  }));
  return paths.flat();
}

function staticImports(source) {
  const imports = [];
  const pattern = /(?:^|;)(?:import|export)(?!\s*\()[^"'`]*?(?:from\s*)?["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier.startsWith(".") || specifier.startsWith("/")) imports.push(specifier);
  }
  return imports;
}

async function initialChunks() {
  if (!(await isFile(indexPath))) {
    throw new Error(`找不到构建产物：${indexPath}。请先执行 npm run build --workspace=@nuedc/dashboard。`);
  }

  const html = await readFile(indexPath, "utf8");
  const roots = [...html.matchAll(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+\.js)["']/g)]
    .map((match) => resolve(outputDir, `.${match[1]}`));
  if (!roots.length) throw new Error("index.html 没有 module 脚本，无法计算首屏 JavaScript。");

  const visited = new Set();
  const visit = async (file) => {
    const resolved = resolve(file);
    if (visited.has(resolved) || !(await isFile(resolved))) return;
    visited.add(resolved);
    const source = await readFile(resolved, "utf8");
    await Promise.all(staticImports(source).map((specifier) => {
      const target = specifier.startsWith("/")
        ? resolve(outputDir, `.${specifier}`)
        : resolve(dirname(resolved), specifier);
      return visit(target);
    }));
  };
  await Promise.all(roots.map(visit));
  return [...visited];
}

try {
  const chunks = await initialChunks();
  const report = await Promise.all(chunks.map(async (file) => {
    const contents = await readFile(file);
    return {
      path: relative(outputDir, file),
      raw: contents.byteLength,
      gzip: gzipSync(contents, { level: 9 }).byteLength,
    };
  }));
  const gzipBytes = report.reduce((sum, chunk) => sum + chunk.gzip, 0);
  const limitBytes = budgetKiB * 1024;
  console.log(`首屏 JS gzip：${(gzipBytes / 1024).toFixed(2)} KiB / ${budgetKiB} KiB`);
  for (const chunk of report.sort((a, b) => b.gzip - a.gzip)) {
    console.log(`  ${(chunk.gzip / 1024).toFixed(2).padStart(7)} KiB gzip  ${chunk.path}`);
  }
  if (gzipBytes > limitBytes) {
    process.exitCode = 1;
    console.error(`首屏 JS 超出预算 ${(gzipBytes - limitBytes) / 1024} KiB；请拆分首屏外页面或减少依赖。`);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : error);
}
