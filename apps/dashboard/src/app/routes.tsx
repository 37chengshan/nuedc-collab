import { useEffect } from "react";
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
import { useRouter } from "@/app/router";

export function AppRoutes() {
  const { pathname, navigate } = useRouter();
  const Page = {
    "/": WorkbenchPage,
    "/tasks": TasksPage,
    "/issues": IssuesPage,
    "/ideas": IdeasPage,
    "/history": HistoryPage,
    "/materials": MaterialsPage,
    "/design": DesignPage,
    "/settings": SettingsPage,
  }[pathname];

  useEffect(() => {
    if (!Page) navigate("/", { replace: true });
  }, [Page, navigate]);

  return Page ? <Page /> : <WorkbenchPage />;
}
