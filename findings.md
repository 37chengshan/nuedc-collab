# Findings & Decisions

## Requirements
- Three computers clone one public GitHub repository and synchronize through GitHub.
- Frontend work is paused. Existing frontend must be archived, not deleted, and remain recoverable.
- One task/issue/idea/event per JSON file; member filenames use GitHub usernames.
- All member/Agent domain actions must be repeatedly callable from scripts/CLI.
- Git pull/commit/push uses 查看→填写→复核→确认→结果; conflict stops with Chinese guidance.
- Contest problem is not published yet; do not invent a detailed solution.
- Except for code directories, internal folders should use Chinese names.
- Root `CLAUDE.md` and `AGENTS.md` must contain matching top-level rules and directory navigation.

## Research Findings
- Existing frontend source, prototypes, plans, tests, and original root configuration are preserved under `归档/前端看板/`.
- Existing protocol and Git core implementation were reusable and have been integrated into the active workspace.
- Welding tutorial local SHA-256: `c84dde49c135bb4b3a51035bd332e98a6bab58d67ccab9de7afe85fb7779c665`.
- K230 reference repository should be pinned to commit `0490ea5` and reviewed for licensing before copying.
- The active scope has no frontend runtime or local port; future restoration must follow `归档/前端看板/README.md`.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| JSON files are the durable communication protocol | Human-readable, Git-friendly, and injectable into a future website |
| Reusable scripts are the recommended mutation boundary | Keeps humans and Agents on the same validated workflow |
| Archived frontend is excluded from the active default workflow | Preserves prior work without blocking the current deliverable |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Grok MCP sessions repeatedly cancelled before implementation completed | User authorized main-thread implementation; work completed directly on current main without worktrees |
| Current npm rejected `workspace:*` | Used npm-compatible `*` workspace dependencies |
| Shell smoke test containing destructive cleanup was rejected | Added reusable Node smoke test with controlled temporary-directory cleanup |

## Resources
- `比赛文档/设计规范/2026-07-28-赛前协作底座设计.md`
- `比赛文档/实施计划/2026-07-28-阶段一仓库与JSON协议实施计划.md`
- `比赛文档/实施计划/2026-07-28-阶段二Git与本地API实施计划.md`
- `归档/前端看板/原型/*.html`
- `/Users/cc/Downloads/MSPM0_小车主板_焊接教程_最终优化版.html`
- `https://github.com/37chengshan/k230-steel-ball-detector`
