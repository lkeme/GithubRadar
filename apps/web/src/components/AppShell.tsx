import { CircleUser, ListChecks, LogOut, Monitor, Moon, Plus, Radar, Settings, Sun, Activity } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, useLocation, useNavigate } from 'react-router';

import { useAuth } from '../features/auth/AuthProvider';
import { LoginDialog } from '../features/auth/LoginDialog';
import { useDashboardUi } from '../features/dashboard/ui-store';
import { usePublicConfig } from '../features/repos/queries';
import { useTheme, type ThemePreference } from '../lib/theme';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { Menu, MenuItem, MenuLabel } from './ui/Menu';
import { cn } from './ui/cn';

/** 全局布局与顶栏：项目名、看板/发现导航、主题切换、登录入口与管理入口。 */

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
];

function NavItem({ to, end, children }: { to: string; end?: boolean; children: string }) {
  return (
    <NavLink
      to={to}
      end={end ?? false}
      className={({ isActive }) =>
        cn(
          // 15px 与品牌名同字号同基线，避免 Latin/CJK 视觉错位（顶栏元素同一视觉中线）。
          'relative inline-flex h-full shrink-0 items-center whitespace-nowrap px-3 text-[15px] leading-6',
          'transition-colors duration-150',
          isActive ? 'font-medium text-text' : 'text-muted hover:text-text',
        )
      }
    >
      {({ isActive }) => (
        <>
          {children}
          {/* 下缘指示条：active 淡入；仅 opacity，落在动效包络内。 */}
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-x-2.5 bottom-0 h-[2px] rounded-full bg-accent transition-opacity duration-150',
              isActive ? 'opacity-100' : 'opacity-0',
            )}
          />
        </>
      )}
    </NavLink>
  );
}

function ThemeMenu() {
  const { preference, setPreference } = useTheme();
  const icon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;
  return (
    <Menu align="end" ariaLabel="主题" trigger={<IconButton icon={icon} label="切换主题" />}>
      <MenuLabel>主题</MenuLabel>
      {THEME_OPTIONS.map((option) => (
        <MenuItem
          key={option.value}
          icon={option.icon}
          checked={preference === option.value}
          onSelect={() => {
            setPreference(option.value);
          }}
        >
          {option.label}
        </MenuItem>
      ))}
    </Menu>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const ui = useDashboardUi();
  const configQuery = usePublicConfig();
  const location = useLocation();
  const navigate = useNavigate();
  const [loginOpen, setLoginOpen] = useState(false);

  const title = configQuery.data?.title ?? 'Github雷达';

  const activateSelection = (): void => {
    if (location.pathname !== '/') {
      navigate('/');
    }
    ui.setSelectionActive(!ui.selectionActive);
  };

  const logout = (): void => {
    ui.setSelectionActive(false);
    void auth.logout();
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-[120] focus:rounded-control focus:border focus:border-border focus:bg-surface focus:px-3 focus:py-2 focus:text-aux2 focus:shadow-pop"
      >
        跳到主要内容
      </a>

      <header className="sticky top-0 z-50 border-b border-border bg-surface/85 supports-[backdrop-filter]:bg-surface/70 supports-[backdrop-filter]:backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[112rem] items-center gap-1 px-4 md:h-16 md:px-6 lg:px-8">
          <Link
            to="/"
            aria-label={title}
            className="flex items-center gap-3 rounded-control px-1.5 py-1 transition-colors duration-150 hover:bg-surface-2"
          >
            {/* 品牌标比导航项明显更大：顶栏的"身份"与"导航"要在第一眼就能分开。 */}
            <span className="gr-brand size-10">
              <Radar size={22} aria-hidden="true" />
            </span>
            {/* 窄屏只留品牌标：顶栏右侧动作图标已占满宽度，名称文字会让导航折行。 */}
            <span className="text-[19px] leading-7 font-semibold tracking-tight text-text max-sm:hidden">{title}</span>
          </Link>
          <span aria-hidden="true" className="mx-2 hidden h-6 w-px shrink-0 bg-border sm:block" />
          <nav aria-label="主导航" className="flex h-full items-center gap-1">
            <NavItem to="/" end>
              看板
            </NavItem>
            <NavItem to="/discover">项目发现</NavItem>
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            <ThemeMenu />

            {auth.status === 'anonymous' ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setLoginOpen(true);
                }}
              >
                登录
              </Button>
            ) : null}

            {auth.isAuthenticated ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  // 用 max-sm:hidden 而不是 hidden sm:inline-flex：Button 自带 inline-flex，
                  // 与 hidden 同等特异性且生成顺序在后，会让 hidden 失效，窄屏按钮仍然占位并遮挡其他控件。
                  className="max-sm:hidden"
                  leadingIcon={<Plus size={15} aria-hidden="true" />}
                  onClick={() => {
                    ui.openImport();
                  }}
                >
                  添加仓库
                </Button>
                <IconButton
                  icon={Plus}
                  label="添加仓库"
                  className="sm:hidden"
                  onClick={() => {
                    ui.openImport();
                  }}
                />
                <Button
                  size="sm"
                  variant={ui.selectionActive ? 'primary' : 'secondary'}
                  // 同上：必须用 max-sm:hidden 才能压过 Button 自带的 inline-flex。
                  className="max-sm:hidden"
                  aria-pressed={ui.selectionActive}
                  onClick={activateSelection}
                >
                  {ui.selectionActive ? '退出选择' : '批量选择'}
                </Button>
                <IconButton
                  icon={ListChecks}
                  label={ui.selectionActive ? '退出批量选择' : '批量选择'}
                  aria-pressed={ui.selectionActive}
                  className="sm:hidden"
                  onClick={activateSelection}
                />
                <Menu align="end" ariaLabel="账户菜单" trigger={<IconButton icon={CircleUser} label="账户菜单" />}>
                  <MenuItem
                    icon={Settings}
                    onSelect={() => {
                      navigate('/settings');
                    }}
                  >
                    系统设置
                  </MenuItem>
                  <MenuItem
                    icon={Activity}
                    onSelect={() => {
                      navigate('/jobs');
                    }}
                  >
                    任务与诊断
                  </MenuItem>
                  <MenuItem icon={LogOut} onSelect={logout}>
                    退出登录
                  </MenuItem>
                </Menu>
              </>
            ) : null}
          </div>
        </div>

        {/* 品牌渐隐分隔线：accent 低透明度的静态装饰，呼应“雷达台”而不构成动画。 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/25 to-transparent"
        />

        {auth.logoutUnconfirmed ? (
          <div role="status" className="border-t border-warning/40 bg-warning-subtle px-4 py-2 text-aux2 text-text md:px-6">
            <div className="mx-auto flex w-full max-w-[112rem] flex-wrap items-center justify-between gap-2">
              <span>本地已锁定管理功能，服务端退出尚未确认。</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void auth.retryLogout();
                }}
              >
                重试退出
              </Button>
            </div>
          </div>
        ) : null}
      </header>

      <main id="main-content" className="flex-1">
        {children}
      </main>

      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
    </div>
  );
}

/** 需要管理会话的页面包装：未登录时进入 /login 并带 returnTo。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.isUnknown) {
    return (
      <div className="mx-auto flex w-full max-w-[112rem] flex-col gap-2 px-4 py-10 md:px-6 lg:px-8">
        <p className="text-aux2 text-muted" role="status">
          {auth.sessionUnavailable ? '无法确认登录状态，管理页面已锁定。' : '正在确认登录状态…'}
        </p>
        {auth.sessionUnavailable ? (
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            onClick={() => {
              void auth.refreshSession();
            }}
          >
            重试
          </Button>
        ) : null}
      </div>
    );
  }
  if (!auth.isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return <>{children}</>;
}
