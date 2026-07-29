import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { AppRoutes } from "./app/routes";
import { ToastProvider } from "./components/Toast";
import { MotionProvider } from "./hooks/useMotion";
import { GitWizardProvider } from "./features/git/GitWizardContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <MotionProvider>
          <ToastProvider>
            <GitWizardProvider>
              <AppShell>
                <AppRoutes />
              </AppShell>
            </GitWizardProvider>
          </ToastProvider>
        </MotionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
