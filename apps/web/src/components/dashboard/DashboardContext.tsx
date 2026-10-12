import { createContext, useContext } from 'react';

import type { PublicRepository, RepositoryControl } from '../../lib/api';

/**
 * 看板上下文：卡片/列表两个视图复用同一份数据模型、RepoActions 与状态组件，
 * 管理能力位一律取自服务器返回的 controls（前端隐藏按钮不是授权机制）。
 */

export interface BrowseState {
  authenticated: boolean;
  setupRequired: boolean;
  controlsById: ReadonlyMap<string, RepositoryControl>;
  labelColors: ReadonlyMap<string, string | null>;
  trendRange: number;
  selectionActive: boolean;
  selected: ReadonlySet<string>;
  /** 任一置顶写操作在途：置顶提交的是完整顺序，其他卡片的置顶入口此刻也不能再发起。 */
  pinsPending: boolean;
  toggleSelected: (id: string) => void;
}

export type RepoActionKind = 'check' | 'pause' | 'pin';

export interface RepoCommands {
  check: (repo: PublicRepository) => void;
  togglePause: (repo: PublicRepository) => void;
  togglePin: (repo: PublicRepository) => void;
  editMonitor: (repo: PublicRepository) => void;
  editLabels: (repo: PublicRepository) => void;
  removeMonitor: (repo: PublicRepository) => void;
  /** 在途状态按“仓库 + 动作”粒度：无关操作不被一并禁用。 */
  busy: (id: string, kind: RepoActionKind) => boolean;
}

export interface DashboardContextValue {
  browse: BrowseState;
  commands: RepoCommands;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export const DashboardProvider = DashboardContext.Provider;

export function useDashboard(): DashboardContextValue {
  const value = useContext(DashboardContext);
  if (value === null) {
    throw new Error('useDashboard 必须在看板页面内使用');
  }
  return value;
}
