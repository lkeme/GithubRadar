import type { CSSProperties } from 'react';
import { Link } from 'react-router';

import { Button } from '../components/ui/Button';
import { RadarRings } from '../components/RadarRings';

/** 未知路径：不渲染空白页，给出明确去向。 */
export function NotFoundPage() {
  return (
    <div className="relative mx-auto flex w-full max-w-md flex-col items-center gap-3.5 px-4 py-24 text-center">
      <RadarRings className="pointer-events-none absolute left-1/2 top-16 -z-10 w-80 -translate-x-1/2 text-accent opacity-60" />
      <p className="gr-rise font-mono text-[13px] font-semibold tracking-[0.2em] text-accent">404</p>
      <h1 className="gr-rise text-title font-semibold tracking-tight text-text" style={{ '--gr-rise-delay': '40ms' } as CSSProperties}>
        页面不存在
      </h1>
      <p className="gr-rise max-w-xs text-aux2 leading-relaxed text-muted" style={{ '--gr-rise-delay': '80ms' } as CSSProperties}>
        地址可能输入有误，或该页面已被移除。
      </p>
      <Button asChild size="sm" variant="secondary" className="gr-rise mt-2">
        <Link to="/">返回看板</Link>
      </Button>
    </div>
  );
}
