import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpen,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Clock3,
  GitBranch,
  LayoutDashboard,
  Lightbulb,
  ListTodo,
  Menu,
  Settings,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/format";
import { NAV_ITEMS } from "@/app/nav";
import { GitStatusBar } from "@/app/GitStatusBar";
import { Button } from "@/components/Button";
import { Drawer } from "@/components/Drawer";
import { useToast } from "@/components/Toast";
import { useGitFetchMutation } from "@/hooks/queries";
import { useGitStatus } from "@/hooks/useGitStatus";
import { useGitWizard } from "@/features/git/GitWizardContext";
import { RouterLink, useRouter } from "@/app/router";
import { isNavActive } from "@/app/nav";

const ICONS = [LayoutDashboard, ListTodo, ShieldAlert, Lightbulb, Clock3, BookOpen, Boxes, Settings];

export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("nuedc.sidebar.collapsed") === "true",
  );
  const [gitPanelExpanded, setGitPanelExpanded] = useState(
    () => window.localStorage.getItem("nuedc.git-panel.expanded") === "true",
  );
  const { pathname } = useRouter();
  const { push } = useToast();
  const { openWizard } = useGitWizard();
  const status = useGitStatus();
  const fetchMutation = useGitFetchMutation();

  useEffect(() => {
    window.localStorage.setItem("nuedc.sidebar.collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem("nuedc.git-panel.expanded", String(gitPanelExpanded));
  }, [gitPanelExpanded]);

  const runFetch = () => {
    fetchMutation.mutate(undefined, {
      onSuccess: (data) => push({ title: "远端状态已更新", description: data.summary, tone: "success" }),
      onError: (error) => push({ title: "检查远端已停止", description: (error as Error).message, tone: "danger" }),
    });
  };

  const renderNavigation = (compact: boolean) => (
    <nav aria-label="主导航" className={compact ? "space-y-3" : "space-y-5"}>
      {(["协作", "证据", "设置"] as const).map((group) => (
        <div key={group}>
          <p className={cn("mb-1.5 px-2 text-[10px] font-semibold tracking-[0.12em] text-faint", compact && "sr-only")}>
            {group}
          </p>
          <div className="space-y-1">
            {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
              const Icon = ICONS[NAV_ITEMS.indexOf(item)] ?? GitBranch;
              return (
                <RouterLink
                  key={item.path}
                  to={item.path}
                  title={compact ? item.label : undefined}
                  className={cn(
                    "group flex min-h-10 items-center rounded-control text-sm transition-colors duration-hover",
                    compact ? "justify-center px-2" : "gap-3 px-2.5 py-2",
                    isNavActive(pathname, item.path)
                      ? "bg-orange-soft/65 text-ink"
                      : "text-subtle hover:bg-muted hover:text-body",
                  )}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0 text-faint group-hover:text-orange" aria-hidden />
                  <span className={cn("font-medium", compact && "sr-only")}>{item.label}</span>
                </RouterLink>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  const current = NAV_ITEMS.find((item) =>
    item.path === "/" ? pathname === "/" : pathname.startsWith(item.path),
  ) ?? NAV_ITEMS[0]!;

  return (
    <div className="min-h-screen bg-canvas font-body text-body">
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-40 hidden border-e border-border bg-sidebar transition-[width] duration-menu lg:block",
          sidebarCollapsed ? "w-[72px]" : "w-56",
        )}
      >
        <div className="flex h-full flex-col">
          <div className={cn("flex h-16 items-center border-b border-border", sidebarCollapsed ? "justify-center px-2" : "gap-3 px-3")}>
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-orange text-white shadow-sm">
              <GitBranch className="h-5 w-5" aria-hidden />
            </div>
            {!sidebarCollapsed ? (
              <div className="min-w-0 flex-1">
                <p className="truncate font-title text-base font-semibold leading-5 text-ink">电赛协作台</p>
                <p className="mt-0.5 truncate text-[11px] text-faint">本地协作看板</p>
              </div>
            ) : null}
            {!sidebarCollapsed ? (
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-control text-faint hover:bg-muted hover:text-body"
                onClick={() => setSidebarCollapsed(true)}
                aria-label="收起侧栏"
                title="收起侧栏"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <div className={cn("min-h-0 flex-1 overflow-auto py-4", sidebarCollapsed ? "px-2" : "px-2.5")}>
            {renderNavigation(sidebarCollapsed)}
          </div>
          <div className={cn("border-t border-border", sidebarCollapsed ? "p-2" : "p-2.5")}>
            <GitStatusBar
              state={status.data}
              fetching={fetchMutation.isPending}
              onFetch={runFetch}
              onOpenWizard={openWizard}
              sidebarCollapsed={sidebarCollapsed}
              expanded={gitPanelExpanded}
              onToggle={() => setGitPanelExpanded((value) => !value)}
            />
          </div>
        </div>
      </aside>

      <div className={cn("min-h-screen transition-[padding] duration-menu", sidebarCollapsed ? "lg:ps-[72px]" : "lg:ps-56")}>
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-surface/95 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {sidebarCollapsed ? (
              <button
                type="button"
                className="hidden h-8 w-8 shrink-0 place-items-center rounded-control text-faint hover:bg-muted hover:text-body lg:grid"
                onClick={() => setSidebarCollapsed(false)}
                aria-label="展开侧栏"
                title="展开侧栏"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            ) : null}
            <button
              type="button"
              className="touch-target grid place-items-center rounded-control text-subtle hover:bg-muted lg:hidden"
              onClick={() => setSidebarOpen(true)}
              aria-label="打开侧栏"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{current.label}</p>
              <p className="hidden truncate text-xs text-faint sm:block">{current.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" loading={fetchMutation.isPending} onClick={runFetch}>
              检查
            </Button>
            <Button size="sm" onClick={() => openWizard("commit")}>提交</Button>
          </div>
        </header>

        {status.data?.severity === "conflict" ? (
          <div className="border-b border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger sm:px-6" role="alert">
            <strong>存在冲突，必须人工处理。</strong>
            <span className="ms-2">{status.data.summary ?? "拉取和推送已禁用，请查看冲突手册。"}</span>
          </div>
        ) : null}

        <main className="px-4 py-5 sm:px-6 lg:px-7">
          <div className="mx-auto max-w-[1500px]">{children}</div>
        </main>
      </div>

      <Drawer open={sidebarOpen} title="导航" description={`电赛协作台 · 当前 ${current.label}`} side="left" onClose={() => setSidebarOpen(false)}>
        {renderNavigation(false)}
      </Drawer>
    </div>
  );
}
