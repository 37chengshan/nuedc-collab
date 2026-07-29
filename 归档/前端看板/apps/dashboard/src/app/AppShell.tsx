import { useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/format";
import { useMotion } from "@/hooks/useMotion";
import { useIsNarrow } from "@/hooks/useMediaQuery";
import { NAV_ITEMS, isNavActive, type NavItem } from "@/app/nav";
import { GitStatusBar } from "@/app/GitStatusBar";
import { Button } from "@/components/Button";
import { useToast } from "@/components/Toast";

export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isNarrow = useIsNarrow();
  const { push } = useToast();
  const { duration } = useMotion();

  const toggleSidebar = () => setSidebarOpen((prev) => !prev);

  const handleOpenWizard = (kind: "pull" | "commit" | "push") => {
    push({
      title: `${kind === "pull" ? "拉取" : kind === "commit" ? "提交" : "推送"} Git 确认面板`,
      description: "将在确认后执行五步流程。",
    });
  };

  const handleOpenDrawer = (path: string) => {
    push({ title: `打开 ${path} 页面` });
  };

  return (
    <div className="flex min-h-screen bg-canvas font-body">
      {/* 侧栏 */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-56 border-r border-border bg-sidebar transition-all duration-drawer",
          sidebarOpen ? "translate-x-0" : "-translate-x-full sm:translate-x-0",
        )}
        style={{ transitionDuration: `${duration("drawer")}ms` }}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
            <div className="flex items-center gap-2">
              <div className="h-6 w-6 rounded-md bg-orange" aria-hidden />
              <span className="font-title text-base font-semibold">本地看板</span>
            </div>
            <button
              type="button"
              className="ml-auto rounded-control p-2 text-subtle hover:bg-panel sm:hidden"
              onClick={toggleSidebar}
              aria-label="关闭侧栏"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <nav className="flex-1 overflow-auto px-2 py-4">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.path}
                href={item.path}
                className={cn(
                  "group flex items-center gap-3 rounded-control px-3 py-2.5 text-sm transition-colors duration-hover",
                  isNavActive(window.location.pathname, item.path)
                    ? "bg-panel text-ink"
                    : "text-subtle hover:bg-muted hover:text-body",
                )}
                onClick={(e) => {
                  if (isNarrow) toggleSidebar();
                  handleOpenDrawer(item.path);
                }}
              >
                <span className="group-hover:scale-110 transition-transform duration-hover">{item.label}</span>
                <span className="text-xs text-faint">{item.description}</span>
              </a>
            ))}
          </nav>

          <div className="border-t border-border p-4">
            <GitStatusBar
              state={undefined}
              onOpenWizard={handleOpenWizard}
              onFetch={() => {
                push({ title: "正在检查远端…" });
              }}
            />
          </div>
        </div>
      </aside>

      {/* 主内容区 */}
      <div className="flex flex-1 flex-col">
        {/* 顶栏 */}
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
          <div className="flex items-center gap-4">
            <button
              type="button"
              className="rounded-control p-2 text-subtle hover:bg-muted sm:hidden"
              onClick={toggleSidebar}
              aria-label="打开侧栏"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="font-title text-lg text-ink">协作看板</div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => handleOpenWizard("fetch")}>
              检查
            </Button>
            <Button variant="primary" size="sm" onClick={() => handleOpenWizard("commit")}>
              提交
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-5xl space-y-6">
            {children}
          </div>
        </main>
      </div>

      {/* 移动端抽屉 */}
      <Drawer open={sidebarOpen} title="导航" onClose={toggleSidebar}>
        <nav className="space-y-1 px-1">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.path}
              href={item.path}
              className="block rounded-control px-3 py-2.5 text-sm"
              onClick={toggleSidebar}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </Drawer>
    </div>
  );
}
