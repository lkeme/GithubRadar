import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  fetchSession,
  login as apiLogin,
  logout as apiLogout,
  postAuthActivity,
  setUnauthorizedHandler,
  type SessionData,
} from '../../lib/api';
import { getAuthEpoch, invalidateAuthEpoch, noteAuthTransition } from '../../lib/auth-epoch';
import { ApiError, StaleAuthError, isAbortError } from '../../lib/errors';
import { removeAdminQueries } from '../../lib/query';

/**
 * 全站共享会话：
 * - 登录状态未知时不渲染任何管理控件（不闪现）。
 * - 每次认证转换递增 authEpoch、清空管理查询缓存；迟到的管理响应按 epoch 丢弃。
 * - 401 安静降级为只读；网络不可达视为认证未知，停止写入而非当作登录成功。
 * - 多标签页用 BroadcastChannel 通知“登录状态有变化”，收到通知后向服务器复核。
 * - 本模块只在内存保存 CSRF token，绝不写入 localStorage/URL/日志。
 */

export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  csrfToken: string | null;
  expiresAt: string | null;
  rememberMe: boolean;
  setupRequired: boolean;
  sessionUnavailable: boolean;
  logoutUnconfirmed: boolean;
  epoch: number;
}

export interface AuthContextValue extends AuthState {
  isAuthenticated: boolean;
  isUnknown: boolean;
  login: (password: string, rememberMe: boolean) => Promise<void>;
  logout: () => Promise<void>;
  retryLogout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const INITIAL_STATE: AuthState = {
  status: 'unknown',
  csrfToken: null,
  expiresAt: null,
  rememberMe: false,
  setupRequired: false,
  sessionUnavailable: false,
  logoutUnconfirmed: false,
  epoch: 0,
};

const AuthContext = createContext<AuthContextValue | null>(null);

const AUTH_CHANNEL = 'githubradar-auth';
const FOCUS_RECHECK_MIN_MS = 30_000;

function broadcastAuthChange(): void {
  try {
    if (typeof BroadcastChannel === 'undefined') {
      return;
    }
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.postMessage('changed');
    channel.close();
  } catch {
    // 不具备广播能力时依赖聚焦/401 复核。
  }
}

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const inFlight = useRef(false);
  const pendingRecheck = useRef(false);
  const lastCheck = useRef(0);
  const pendingLogout = useRef<string | null>(null);

  const applySession = useCallback(
    (data: SessionData, options: { bump: boolean }): void => {
      if (options.bump) {
        noteAuthTransition();
        removeAdminQueries(queryClient);
      }
      setState((prev) => ({
        ...prev,
        status: data.authenticated ? 'authenticated' : 'anonymous',
        csrfToken: data.csrfToken,
        expiresAt: data.expiresAt,
        rememberMe: data.rememberMe,
        setupRequired: data.setupRequired,
        sessionUnavailable: false,
        epoch: getAuthEpoch(),
      }));
    },
    [queryClient],
  );

  const refreshSessionInternal = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      // 复核不能被在途请求静默跳过（bfcache 恢复等场景）：记录待复核，由当前请求收尾时补跑。
      pendingRecheck.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        pendingRecheck.current = false;
        try {
          const data = await fetchSession();
          const nextStatus: AuthStatus = data.authenticated ? 'authenticated' : 'anonymous';
          const prevStatus = stateRef.current.status;
          applySession(data, { bump: prevStatus !== 'unknown' && prevStatus !== nextStatus });
        } catch (error) {
          // 认证代际已变化（退出/重新登录/bfcache 后在途的旧响应）或请求被取消：
          // 结果无效、静默丢弃，不能据此宣告会话不可达。
          if (isAbortError(error) || error instanceof StaleAuthError) {
            continue;
          }
          // 网络不可达视为认证未知：停止写入。
          setState((prev) => ({ ...prev, status: 'unknown', sessionUnavailable: true }));
        }
      } while (pendingRecheck.current);
    } finally {
      inFlight.current = false;
      lastCheck.current = Date.now();
    }
  }, [applySession]);

  const refreshSession = useCallback(async (): Promise<void> => {
    await refreshSessionInternal();
  }, [refreshSessionInternal]);

  useEffect(() => {
    void refreshSessionInternal();
  }, [refreshSessionInternal]);

  useEffect(() => {
    const onFocus = (): void => {
      if (Date.now() - lastCheck.current < FOCUS_RECHECK_MIN_MS) {
        return;
      }
      void refreshSessionInternal();
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted) {
        return;
      }
      // bfcache 恢复：先隐藏管理层、丢弃在途管理响应，再复核会话。
      // 隐藏状态必须带上新 epoch，否则渲染出的仍是旧代际，在途旧响应可能被误判为同一代际。
      invalidateAuthEpoch();
      setState((prev) => ({ ...prev, status: 'unknown', epoch: getAuthEpoch() }));
      void refreshSessionInternal();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.onmessage = () => {
        void refreshSessionInternal();
      };
    }
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      channel?.close();
    };
  }, [refreshSessionInternal]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // 401 安静降级为只读：不打断浏览、不弹强制登录。
      if (stateRef.current.status === 'authenticated') {
        noteAuthTransition();
        removeAdminQueries(queryClient);
        setState((prev) => ({
          ...prev,
          status: 'anonymous',
          csrfToken: null,
          epoch: getAuthEpoch(),
        }));
      }
    });
    return () => {
      setUnauthorizedHandler(null);
    };
  }, [queryClient]);

  // 活跃心跳：仅页面可见且近期有真实用户输入时发送，最多每 5 分钟一次。
  useEffect(() => {
    let lastInputAt = Date.now();
    const markInput = (): void => {
      lastInputAt = Date.now();
    };
    window.addEventListener('pointerdown', markInput, { passive: true });
    window.addEventListener('keydown', markInput, { passive: true });
    const timer = window.setInterval(() => {
      const current = stateRef.current;
      if (current.status !== 'authenticated' || current.csrfToken === null) {
        return;
      }
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (Date.now() - lastInputAt > 10 * 60_000) {
        return;
      }
      void postAuthActivity(current.csrfToken).catch(() => {
        // 心跳失败不改变本地状态；会话有效性以服务端复核为准。
      });
    }, 5 * 60_000);
    return () => {
      window.removeEventListener('pointerdown', markInput);
      window.removeEventListener('keydown', markInput);
      window.clearInterval(timer);
    };
  }, []);

  const login = useCallback(
    async (password: string, rememberMe: boolean): Promise<void> => {
      const loginSession = await apiLogin(password, rememberMe);
      // 登录成功先递增认证代际再拉取会话：登录前发出的匿名会话响应到达时会因 epoch
      // 不匹配被丢弃，不会把刚建立的登录状态反向踢回匿名。
      noteAuthTransition();
      removeAdminQueries(queryClient);
      let session: SessionData | null = null;
      try {
        session = await fetchSession();
      } catch (error) {
        // 登录后立即被撤销（退出/改密/其他标签页转换）时，迟到的会话结果不能作为登录依据。
        if (error instanceof StaleAuthError) {
          return;
        }
        // 会话端点暂时不可达（网络抖动）：登录响应本身就携带会话数据，用它兜底。
        session = loginSession.authenticated ? loginSession : null;
      }
      broadcastAuthChange();
      // 只有会话数据确实存在（带 csrfToken）才进入已登录：否则保持"认证未知"，
      // 交由聚焦/广播复核路径重试，避免"已登录但 csrfToken 为 null"的半残状态
      // （写操作会全部以 CSRF_REJECTED 失败直到下次复核）。
      if (session === null || session.csrfToken === null) {
        setState((prev) => ({
          ...prev,
          status: 'unknown',
          csrfToken: null,
          expiresAt: null,
          sessionUnavailable: false,
          logoutUnconfirmed: false,
          epoch: getAuthEpoch(),
        }));
        return;
      }
      const confirmedSession = session;
      setState((prev) => ({
        ...prev,
        status: 'authenticated',
        csrfToken: confirmedSession.csrfToken,
        expiresAt: confirmedSession.expiresAt,
        rememberMe: confirmedSession.rememberMe,
        setupRequired: confirmedSession.setupRequired,
        sessionUnavailable: false,
        logoutUnconfirmed: false,
        epoch: getAuthEpoch(),
      }));
    },
    [queryClient],
  );

  const performLogout = useCallback(
    async (csrf: string | null): Promise<void> => {
      try {
        await apiLogout(csrf);
        pendingLogout.current = null;
        setState((prev) => ({ ...prev, logoutUnconfirmed: false }));
        broadcastAuthChange();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          // 服务端已无有效会话，视为退出完成。
          pendingLogout.current = null;
          setState((prev) => ({ ...prev, logoutUnconfirmed: false }));
          broadcastAuthChange();
          return;
        }
        // 网络失败：本地已锁定，但不宣称服务端退出成功；保留可重试动作。
        setState((prev) => ({ ...prev, logoutUnconfirmed: true }));
      }
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    const csrf = stateRef.current.csrfToken;
    pendingLogout.current = csrf;
    noteAuthTransition();
    removeAdminQueries(queryClient);
    setState((prev) => ({
      ...prev,
      status: 'anonymous',
      csrfToken: null,
      epoch: getAuthEpoch(),
    }));
    await performLogout(csrf);
  }, [performLogout, queryClient]);

  const retryLogout = useCallback(async (): Promise<void> => {
    await performLogout(pendingLogout.current);
  }, [performLogout]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      isAuthenticated: state.status === 'authenticated',
      isUnknown: state.status === 'unknown',
      login,
      logout,
      retryLogout,
      refreshSession,
    }),
    [state, login, logout, retryLogout, refreshSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth 必须在 AuthProvider 内使用');
  }
  return context;
}
