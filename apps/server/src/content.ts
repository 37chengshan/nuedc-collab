import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MATERIAL_ROOTS = ["比赛文档", "参考资料", "reference-code"] as const;
const DESIGN_ROOTS = [
  "比赛设计",
  "比赛文档/设计模板",
  "比赛文档/设计规范",
  "比赛文档/方案模板",
  "比赛文档/实施计划",
] as const;

type PreviewMode = "text" | "sandboxHtml" | "image" | "pdf" | "downloadOnly";

export interface WarningItem {
  code: string;
  message: string;
  target?: string;
}

export interface MaterialItem {
  id: string;
  title: string;
  type: "notice" | "hardware" | "tutorial" | "externalRepository" | "document";
  relativePath: string;
  sourceLabel: string;
  versionLabel?: string;
  modules: string[];
  verificationStatus: "verified" | "pending" | "archived" | "outdated";
  updatedAt: string;
  sizeBytes: number;
  sha256?: string;
  previewMode: PreviewMode;
}

export interface DesignEntry {
  id: string;
  title: string;
  category: "赛题分析" | "总体方案" | "接口约定" | "测试记录" | "可视化页面";
  relativePath: string;
  format: "markdown" | "html" | "json";
  updatedAt: string;
  previewMode?: PreviewMode;
}

export interface DesignCanvasNode {
  id: string;
  title?: string;
  label?: string;
  responsibility: string;
  inputs: string[];
  outputs: string[];
  status: string;
  x: number;
  y: number;
}

export interface DesignCanvasEdge {
  id?: string;
  from: string;
  to: string;
  label?: string;
}

export interface DesignCanvas {
  sourcePath?: string;
  nodes: DesignCanvasNode[];
  edges: DesignCanvasEdge[];
}

export interface DesignResponse {
  entries: DesignEntry[];
  canvas: DesignCanvas | null;
  context: {
    issueIds: string[];
    materialIds: string[];
    decisionEventIds: string[];
  };
  warnings: WarningItem[];
}

export interface FileContentResponse {
  path: string;
  contentType: string;
  body?: string;
  url?: string;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("路径必须是仓库内相对路径。");
  }
  const resolved = path.posix.normalize(normalized);
  if (resolved === "." || resolved.startsWith("../") || resolved.includes("/../")) {
    throw new Error("路径越界已被拒绝。");
  }
  return resolved;
}

function isAllowedRelativePath(relativePath: string, allowedRoots: readonly string[]): boolean {
  return allowedRoots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`));
}

async function walkFiles(base: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(base, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(absolute)));
      continue;
    }
    if (entry.isFile()) results.push(absolute);
  }
  return results;
}

function detectPreviewMode(relativePath: string): PreviewMode {
  const ext = path.extname(relativePath).toLowerCase();
  if ([".md", ".markdown", ".txt", ".json", ".yml", ".yaml"].includes(ext)) return "text";
  if ([".html", ".htm"].includes(ext)) return "sandboxHtml";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  return "downloadOnly";
}

function detectContentType(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  if ([".md", ".markdown"].includes(ext)) return "text/markdown; charset=utf-8";
  if ([".txt", ".log"].includes(ext)) return "text/plain; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if ([".html", ".htm"].includes(ext)) return "text/html; charset=utf-8";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function makeStableId(prefix: string, relativePath: string): string {
  return `${prefix}-${sha256Text(relativePath).slice(0, 12)}`;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function detectMaterialType(relativePath: string): MaterialItem["type"] {
  if (relativePath.startsWith("reference-code/") || relativePath.includes("外部仓库")) return "externalRepository";
  if (relativePath.includes("硬件")) return "hardware";
  if (/(协作手册|操作指南|设备准备|教程|指南)/.test(relativePath)) return "tutorial";
  if (relativePath.startsWith("比赛文档/")) return "notice";
  return "document";
}

function detectDesignCategory(relativePath: string): DesignEntry["category"] {
  if (relativePath.includes("接口") || relativePath.includes("协议")) return "接口约定";
  if (relativePath.includes("测试")) return "测试记录";
  if (relativePath.includes("可视化") || relativePath.includes("画布")) return "可视化页面";
  if (relativePath.includes("题目") || relativePath.includes("分析")) return "赛题分析";
  return "总体方案";
}

function detectDesignFormat(relativePath: string): DesignEntry["format"] {
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === ".json") return "json";
  if ([".html", ".htm"].includes(ext)) return "html";
  return "markdown";
}

function buildSandboxHtml(rawHtml: string, title: string): string {
  const escaped = rawHtml
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    `  <title>${title}</title>`,
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <style>html,body,iframe{margin:0;padding:0;width:100%;height:100%;border:0;background:#fff}</style>",
    "</head>",
    "<body>",
    `  <iframe sandbox=\"\" referrerpolicy=\"no-referrer\" srcdoc=\"${escaped}\"></iframe>`,
    "</body>",
    "</html>",
  ].join("");
}

async function listFilesForRoots(repoRoot: string, roots: readonly string[]): Promise<string[]> {
  const all: string[] = [];
  for (const root of roots) {
    const base = path.resolve(repoRoot, root);
    const files = await walkFiles(base);
    for (const file of files) {
      all.push(toPosix(path.relative(repoRoot, file)));
    }
  }
  return all.sort((a, b) => a.localeCompare(b));
}

function resolveAllowedPath(repoRoot: string, relativePath: string, allowedRoots: readonly string[]): string {
  const normalized = normalizeRelativePath(relativePath);
  if (!isAllowedRelativePath(normalized, allowedRoots)) {
    throw new Error("仅允许访问白名单资料目录。");
  }
  const absolute = path.resolve(repoRoot, normalized);
  const repoRelative = toPosix(path.relative(repoRoot, absolute));
  if (repoRelative.startsWith("../") || repoRelative === "..") {
    throw new Error("路径越界已被拒绝。");
  }
  return absolute;
}

export async function listMaterials(repoRoot: string): Promise<{ items: MaterialItem[]; warnings: WarningItem[] }> {
  const files = await listFilesForRoots(repoRoot, MATERIAL_ROOTS);
  const items = await Promise.all(
    files.map(async (relativePath) => {
      const absolute = path.resolve(repoRoot, relativePath);
      const info = await stat(absolute);
      const previewMode = detectPreviewMode(relativePath);
      return {
        id: makeStableId("material", relativePath),
        title: stripExtension(path.basename(relativePath)),
        type: detectMaterialType(relativePath),
        relativePath,
        sourceLabel: relativePath.startsWith("reference-code/") ? "参考代码" : "仓库资料",
        modules: [],
        verificationStatus: "verified" as const,
        updatedAt: info.mtime.toISOString(),
        sizeBytes: info.size,
        previewMode,
      };
    }),
  );
  return { items, warnings: [] };
}

export async function readMaterialContent(repoRoot: string, relativePath: string): Promise<FileContentResponse> {
  return readAllowedContent(repoRoot, relativePath, MATERIAL_ROOTS);
}

export async function listDesign(
  repoRoot: string,
  eventRefs: { issueIds: string[]; decisionEventIds: string[] } = { issueIds: [], decisionEventIds: [] },
): Promise<DesignResponse> {
  const files = await listFilesForRoots(repoRoot, DESIGN_ROOTS);
  const entries = await Promise.all(
    files.map(async (relativePath) => {
      const absolute = path.resolve(repoRoot, relativePath);
      const info = await stat(absolute);
      const format = detectDesignFormat(relativePath);
      return {
        id: makeStableId("design", relativePath),
        title: stripExtension(path.basename(relativePath)),
        category: detectDesignCategory(relativePath),
        relativePath,
        format,
        updatedAt: info.mtime.toISOString(),
        previewMode: detectPreviewMode(relativePath),
      };
    }),
  );

  const canvasEntry =
    entries.find((entry) => entry.relativePath === "比赛设计/总体方案/系统画布.json") ??
    entries.find((entry) => entry.relativePath.endsWith("画布.json")) ??
    null;

  let canvas: DesignCanvas | null = null;
  let materialIds: string[] = [];
  if (canvasEntry) {
    try {
      const absolute = path.resolve(repoRoot, canvasEntry.relativePath);
      const raw = JSON.parse(await readFile(absolute, "utf8")) as Record<string, unknown>;
      const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
      const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
      canvas = {
        sourcePath: canvasEntry.relativePath,
        nodes: rawNodes.map((node, index) => {
          const item = (node ?? {}) as Record<string, unknown>;
          return {
            id: String(item.id ?? `node-${index + 1}`),
            ...(typeof item.title === "string" ? { title: item.title } : {}),
            ...(typeof item.label === "string" ? { label: item.label } : {}),
            responsibility:
              typeof item.responsibility === "string"
                ? item.responsibility
                : typeof item.module === "string"
                  ? item.module
                  : typeof item.label === "string"
                    ? item.label
                    : "未命名职责",
            inputs: Array.isArray(item.inputs) ? item.inputs.map(String) : [],
            outputs: Array.isArray(item.outputs) ? item.outputs.map(String) : [],
            status: typeof item.status === "string" ? item.status : "unknown",
            x: typeof item.x === "number" ? item.x : index * 220,
            y: typeof item.y === "number" ? item.y : 0,
          };
        }),
        edges: rawEdges.map((edge, index) => {
          const item = (edge ?? {}) as Record<string, unknown>;
          return {
            id: typeof item.id === "string" ? item.id : `edge-${index + 1}`,
            from: String(item.from ?? ""),
            to: String(item.to ?? ""),
            ...(typeof item.label === "string" ? { label: item.label } : {}),
          };
        }),
      };
      const context = (raw.context ?? {}) as Record<string, unknown>;
      materialIds = Array.isArray(context.linkedMaterialIds) ? context.linkedMaterialIds.map(String) : [];
    } catch {
      canvas = null;
    }
  }

  return {
    entries,
    canvas,
    context: {
      issueIds: eventRefs.issueIds,
      materialIds,
      decisionEventIds: eventRefs.decisionEventIds,
    },
    warnings: [],
  };
}

export async function readDesignContent(repoRoot: string, relativePath: string): Promise<FileContentResponse> {
  const content = await readAllowedContent(repoRoot, relativePath, DESIGN_ROOTS);
  return {
    path: content.path,
    contentType: content.contentType,
    body: content.body ?? "",
  };
}

async function readAllowedContent(
  repoRoot: string,
  relativePath: string,
  allowedRoots: readonly string[],
): Promise<FileContentResponse> {
  const absolute = resolveAllowedPath(repoRoot, relativePath, allowedRoots);
  const contentType = detectContentType(relativePath);
  const previewMode = detectPreviewMode(relativePath);

  if (previewMode === "image" || previewMode === "pdf" || previewMode === "downloadOnly") {
    throw new Error("当前仅支持文本、JSON 与 HTML 预览。");
  }

  const raw = await readFile(absolute, "utf8");
  if (previewMode === "sandboxHtml") {
    return {
      path: normalizeRelativePath(relativePath),
      contentType,
      body: buildSandboxHtml(raw, path.basename(relativePath)),
    };
  }

  return {
    path: normalizeRelativePath(relativePath),
    contentType,
    body: raw,
  };
}
