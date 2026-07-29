import { useState, type ReactNode } from "react";
import {
  BookOpen,
  Boxes,
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
import { useGitFetchMutation, useGitStatusQuery } from "@/hooks/queries";
import { useGitWizard } from "@/features/git/GitWizardContext";
import { RouterLink, useRouter } from "@/app/router";
import { isNavActive } from "@/app/nav";

const ICONS = [LayoutDashboard, ListTodo, ShieldAlert, Lightbulb, Clock3, BookOpen, Boxes, Settings];

export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { pathname } = useRouter();
  const { push } = useToast();
  const { openWizard } = useGitWizard();
  const status = useGitStatusQuery();
  const fetchMutation = useGitFetchMutation();

  const runFetch = () => {
    fetchMutation.mutate(undefined, {
      onSuccess: (data) => push({ title: "远端状态已更新", description: data.summary, tone: "success" }),
      onError: (error) => push({ title: "检查远端已停止", description: (error as Error).message, tone: "danger" }),
    });
  };

  const navigation = (
    <nav aria-label="主导航" className="space-y-6">
      {(["协作", "证据", "设置"] as const).map((group) => (
        <div key={group}>
          <p className="mb-2 px-3 text-[11px] font-semibold tracking-[0.14em] text-faint">{group}</p>
          <div className="space-y-1">
            {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
              const Icon = ICONS[NAV_ITEMS.indexOf(item)] ?? GitBranch;
              return (
                <RouterLink
                  key={item.path}
                  to={item.path}
                  className={cn(
                    "group flex min-h-11 items-center gap-3 rounded-control px-3 py-2 text-sm transition-colors duration-hover",
                    isNavActive(pathname, item.path)
                      ? "bg-panel text-ink shadow-sm"
                      : "text-subtle hover:bg-muted hover:text-body",
                  )}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0 text-faint group-hover:text-orange" aria-hidden />
                  <span className="font-medium">{item.label}</span>
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
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-64 border-e border-border bg-sidebar lg:block">
        <div className="flex h-full flex-col">
          <div className="flex h-[72px] items-center gap-3 border-b border-border px-5">
            <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-orange text-white shadow-sm">
              <GitBranch className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="font-title text-lg font-semibold leading-5 text-ink">电赛协作台</p>
              <p className="mt-1 text-xs text-faint">三台电脑 · 一个事实源</p>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-5">{navigation}</div>
          <div className="border-t border-border p-3">
            <GitStatusBar
              state={status.data}
              fetching={fetchMutation.isPending}
              onFetch={runFetch}
              onOpenWizard={openWizard}
            />
          </div>
        </div>
      </aside>

      <div className="min-h-screen lg:ps-64">
        <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-border bg-surface/95 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
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

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1500px]">{children}</div>
        </main>
      </div>

      <Drawer open={sidebarOpen} title="导航" description={`电赛协作台 · 当前 ${current.label}`} side="left" onClose={() => setSidebarOpen(false)}>
        {navigation}
      </Drawer>
    </div>
  );
}
