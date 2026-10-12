import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * 看板级 UI 状态（跨顶栏与页面）：添加仓库对话框与批量选择开关。
 * 顶栏的“添加仓库/批量选择”与看板页面共享同一状态。
 * 选择集合本身由页面持有：筛选/翻页清空、切换视图保留。
 */

interface DashboardUiState {
  importOpen: boolean;
  importInitialInput: string | null;
  openImport: (initialInput?: string) => void;
  closeImport: () => void;
  selectionActive: boolean;
  setSelectionActive: (active: boolean) => void;
}

const DashboardUiContext = createContext<DashboardUiState | null>(null);

export function DashboardUiProvider({ children }: { children: ReactNode }) {
  const [importOpen, setImportOpen] = useState(false);
  const [importInitialInput, setImportInitialInput] = useState<string | null>(null);
  const [selectionActive, setSelectionActive] = useState(false);

  const openImport = useCallback((initialInput?: string) => {
    setImportInitialInput(initialInput ?? null);
    setImportOpen(true);
  }, []);

  const closeImport = useCallback(() => {
    setImportOpen(false);
  }, []);

  const value = useMemo<DashboardUiState>(
    () => ({
      importOpen,
      importInitialInput,
      openImport,
      closeImport,
      selectionActive,
      setSelectionActive,
    }),
    [importOpen, importInitialInput, openImport, closeImport, selectionActive],
  );

  return <DashboardUiContext.Provider value={value}>{children}</DashboardUiContext.Provider>;
}

export function useDashboardUi(): DashboardUiState {
  const value = useContext(DashboardUiContext);
  if (value === null) {
    throw new Error('useDashboardUi 必须在 DashboardUiProvider 内使用');
  }
  return value;
}
