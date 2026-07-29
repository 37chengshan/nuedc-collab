import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';

function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} />
      <EmptyState
        title={`${title}业务模块加载中`}
        description="壳层、路由与共享组件已就绪。页面业务模块由另一实现线写入 features/pages。"
      />
    </div>
  );
}

export function WorkbenchPage() {
  return <Placeholder title="工作台" description="仓库脉搏、今日任务与三人协作摘要。" />;
}
export function TasksPage() {
  return <Placeholder title="任务" description="四列 Kanban、筛选与负责人流转。" />;
}
export function IssuesPage() {
  return <Placeholder title="问题" description="严重度筛选、症状与关联任务。" />;
}
export function IdeasPage() {
  return <Placeholder title="想法" description="探索、拒绝理由与提升为任务。" />;
}
export function HistoryPage() {
  return <Placeholder title="提交历史" description="提交时间线与只读 diff，与推送分离。" />;
}
export function MaterialsPage() {
  return <Placeholder title="参考资料" description="教程、硬件资料与安全预览。" />;
}
export function DesignPage() {
  return <Placeholder title="总体设计" description="赛前准备文档与系统画布。" />;
}
export function SettingsPage() {
  return <Placeholder title="设置" description="本机身份、同步策略与 13 个 Agent 动作映射。" />;
}
