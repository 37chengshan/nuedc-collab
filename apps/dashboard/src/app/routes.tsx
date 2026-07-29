import { Navigate, Route, Routes } from "react-router-dom";
import {
  DesignPage,
  HistoryPage,
  IdeasPage,
  IssuesPage,
  MaterialsPage,
  SettingsPage,
  TasksPage,
  WorkbenchPage,
} from "@/pages/placeholders";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<WorkbenchPage />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/issues" element={<IssuesPage />} />
      <Route path="/ideas" element={<IdeasPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/materials" element={<MaterialsPage />} />
      <Route path="/design" element={<DesignPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
