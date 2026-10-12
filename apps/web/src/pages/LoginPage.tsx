import { Radar } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';

import { LoginForm } from '../features/auth/LoginForm';
import { useAuth } from '../features/auth/AuthProvider';
import { Button } from '../components/ui/Button';
import { RadarRings } from '../components/RadarRings';
import { safeReturnTo } from '../lib/url';

/**
 * 独立登录入口 /login：
 * 与登录弹窗共用一套表单逻辑；成功后回到 returnTo 指定的站内页面。
 */
export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get('returnTo'));

  if (auth.isAuthenticated) {
    return <Navigate to={returnTo} replace />;
  }

  return (
    <div className="relative mx-auto flex w-full max-w-md flex-col justify-center gap-6 px-4 py-14 md:py-20">
      {/* 雷达环装饰：fixed 定位（不参与文档滚动区域，375px 不产生横向溢出），静态同心圆。 */}
      <RadarRings className="pointer-events-none fixed left-1/2 top-1/2 -z-10 w-[42rem] max-w-none -translate-x-1/2 -translate-y-1/2 text-accent opacity-70" />
      <header className="gr-rise flex flex-col items-center gap-3.5 text-center">
        <span className="gr-brand size-11">
          <Radar size={22} aria-hidden="true" />
        </span>
        <h1 className="text-display font-semibold text-text">登录管理</h1>
        <p className="max-w-xs text-aux2 leading-relaxed text-muted">
          公开看板无需登录即可浏览；登录后才能执行添加、检测、编辑等管理操作。
        </p>
      </header>
      <div className="gr-card gr-rise p-6 md:p-7" style={{ '--gr-rise-delay': '60ms' } as CSSProperties}>
        {auth.isUnknown ? (
          <div className="flex flex-col gap-2">
            <p className="text-aux2 text-muted" role="status">
              {auth.sessionUnavailable ? '无法确认登录状态，请检查网络后重试。' : '正在确认登录状态…'}
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
        ) : (
          <LoginForm
            onSuccess={() => {
              navigate(returnTo, { replace: true });
            }}
          />
        )}
      </div>
      <p className="gr-rise text-center text-aux text-muted" style={{ '--gr-rise-delay': '100ms' } as CSSProperties}>
        <Link to="/" className="rounded-[4px] font-medium text-accent underline-offset-2 transition-colors duration-150 hover:text-accent-strong hover:underline">
          返回看板
        </Link>
      </p>
    </div>
  );
}
