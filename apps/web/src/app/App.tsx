import { useQueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';

import { AppShell } from '../components/AppShell';
import { BulkImportDialog } from '../components/dashboard/BulkImportDialog';
import { TooltipRoot } from '../components/ui/IconButton';
import { ToastProvider } from '../components/ui/Toast';
import { AuthProvider } from '../features/auth/AuthProvider';
import { useDashboardUi, DashboardUiProvider } from '../features/dashboard/ui-store';
import { createQueryClient, invalidateAfterWrite } from '../lib/query';
import { ThemeProvider } from '../lib/theme';
import { DashboardPage } from '../pages/DashboardPage';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';

// 管理页面与发现页懒加载：首屏不预载全量趋势与发现数据。
const SettingsPage = lazy(() => import('../pages/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const JobsPage = lazy(() => import('../pages/JobsPage').then((module) => ({ default: module.JobsPage })));
const DiscoverPage = lazy(() => import('../pages/DiscoverPage').then((module) => ({ default: module.DiscoverPage })));

function RouteFallback() {
  return (
    <div className="mx-auto flex w-full max-w-[112rem] items-center gap-2.5 px-4 py-10 md:px-6 lg:px-8">
      <span aria-hidden="true" className="gr-skeleton size-4 rounded-full" />
      <p className="text-aux2 text-muted" role="status">
        正在加载页面…
      </p>
    </div>
  );
}

/** 全局导入对话框：顶栏“添加仓库”与项目发现“加入监控”共用。 */
function GlobalImportDialog() {
  const ui = useDashboardUi();
  const queryClient = useQueryClient();
  return (
    <BulkImportDialog
      open={ui.importOpen}
      onOpenChange={(next) => {
        if (next) {
          ui.openImport();
        } else {
          ui.closeImport();
        }
      }}
      initialInput={ui.importInitialInput ?? undefined}
      onFinished={() => {
        invalidateAfterWrite(queryClient, 'repositories');
      }}
    />
  );
}

export function App(): ReactNode {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <TooltipRoot>
            <AuthProvider>
              <DashboardUiProvider>
                <BrowserRouter>
                  <AppShell>
                    <Suspense fallback={<RouteFallback />}>
                      <Routes>
                        <Route path="/" element={<DashboardPage />} />
                        <Route path="/discover" element={<DiscoverPage />} />
                        <Route path="/login" element={<LoginPage />} />
                        <Route path="/settings" element={<SettingsPage />} />
                        <Route path="/jobs" element={<JobsPage />} />
                        <Route path="*" element={<NotFoundPage />} />
                      </Routes>
                    </Suspense>
                  </AppShell>
                  <GlobalImportDialog />
                </BrowserRouter>
              </DashboardUiProvider>
            </AuthProvider>
          </TooltipRoot>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
