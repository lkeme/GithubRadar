import { TrendingDown, TrendingUp } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { TrendPoint } from '../lib/api';
import { serverNow, useNowTick } from '../lib/clock';
import { formatExactCount, formatSignedCount } from '../lib/format';
import { beijingDayString, beijingDayToUtcMs, formatBeijingDay } from '../lib/relative-time';
import { cn } from './ui/cn';

export interface SparklineProps {
  points: TrendPoint[];
  /** 观察窗口天数：7/30/90/365。 */
  days: number;
  metric: 'stars' | 'forks';
  className?: string;
  label?: string;
}

const WIDTH = 104;
const HEIGHT = 28;
const PAD = 2;
const DAY_MS = 86_400_000;

interface PreparedSeries {
  visible: TrendPoint[];
  segments: TrendPoint[][];
  gaps: number;
  first: TrendPoint;
  last: TrendPoint;
  delta: number;
}

function prepareSeries(points: TrendPoint[], days: number, metric: 'stars' | 'forks'): PreparedSeries | null {
  const now = serverNow();
  const cutoffDay = beijingDayString(now - (days - 1) * DAY_MS);
  const sorted = [...points].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const visible = sorted.filter((point) => point.day >= cutoffDay);
  if (visible.length < 2) {
    return null;
  }
  const segments: TrendPoint[][] = [];
  let current: TrendPoint[] = [];
  let gaps = 0;
  let previous: TrendPoint | null = null;
  for (const point of visible) {
    if (previous !== null) {
      const gapDays = (beijingDayToUtcMs(point.day) - beijingDayToUtcMs(previous.day)) / DAY_MS;
      if (gapDays > 1) {
        gaps += 1;
        segments.push(current);
        current = [];
      }
    }
    current.push(point);
    previous = point;
  }
  if (current.length > 0) {
    segments.push(current);
  }
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  return {
    visible,
    segments,
    gaps,
    first,
    last,
    delta: last[metric] - first[metric],
  };
}

function buildPositions(visible: TrendPoint[], metric: 'stars' | 'forks'): Array<{ x: number; y: number; point: TrendPoint }> {
  const values = visible.map((point) => point[metric]);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const innerW = WIDTH - PAD * 2;
  const innerH = HEIGHT - PAD * 2;
  return visible.map((point, index) => {
    const x = visible.length === 1 ? WIDTH / 2 : PAD + (index / (visible.length - 1)) * innerW;
    const y = PAD + (1 - (point[metric] - min) / span) * innerH;
    return { x, y, point };
  });
}

/**
 * 微型趋势 SVG：
 * - 缺少相邻日期的点断开，不补零；说明存在缺测日。
 * - 文本摘要 + 可聚焦数据提示；涨跌用箭头与正负号表达，不只靠颜色。
 * - 不足两点显示“趋势积累中”；零基数不出现无穷百分比（只展示绝对值差）。
 * - 面积填充只是 accent 的静态淡染，不构成持续动画。
 */
export function Sparkline({ points, days, metric, className, label }: SparklineProps) {
  useNowTick();
  const [focused, setFocused] = useState(false);
  // 悬浮窗锚点：进入时测量的视口坐标；经 Portal + fixed 定位渲染，
  // 不受卡片/列表容器 overflow-hidden 裁切（列表首行向上弹会被容器顶边裁掉）。
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const descriptionId = useId();
  const gradientId = useId();
  const prepared = prepareSeries(points, days, metric);
  const metricLabel = label ?? (metric === 'stars' ? 'Star' : 'Fork');

  const open = (): void => {
    const rect = svgRef.current?.getBoundingClientRect();
    setAnchor(rect ? { top: rect.top, bottom: rect.bottom, left: rect.left } : null);
    setFocused(true);
  };
  const close = (): void => {
    setFocused(false);
    setAnchor(null);
  };

  if (prepared === null) {
    return (
      <span className={cn('text-aux text-muted', className)} title="至少需要两个已观测日才能绘制趋势">
        趋势积累中
      </span>
    );
  }

  const positions = buildPositions(prepared.visible, metric);
  const positionOf = new Map(positions.map((position) => [position.point.day, position]));

  const lineSegments: string[] = [];
  const areaSegments: string[] = [];
  for (const segment of prepared.segments) {
    const coords = segment
      .map((point) => positionOf.get(point.day))
      .filter((position): position is { x: number; y: number; point: TrendPoint } => position !== undefined);
    if (coords.length >= 2) {
      const line = coords.map((position) => `${position.x.toFixed(1)},${position.y.toFixed(1)}`);
      lineSegments.push(line.join(' '));
      const firstPosition = coords[0];
      const lastPosition = coords[coords.length - 1];
      if (firstPosition !== undefined && lastPosition !== undefined) {
        areaSegments.push(
          `${line.join(' ')} ${lastPosition.x.toFixed(1)},${(HEIGHT - PAD).toFixed(1)} ${firstPosition.x.toFixed(1)},${(HEIGHT - PAD).toFixed(1)}`,
        );
      }
    }
  }

  const lastPosition = positions[positions.length - 1];

  const direction = prepared.delta > 0 ? 'up' : prepared.delta < 0 ? 'down' : 'flat';
  const directionText =
    direction === 'up' ? '上升' : direction === 'down' ? '下降' : '持平';
  const gapText = prepared.gaps > 0 ? `；存在 ${prepared.gaps} 处缺测日，折线在该处断开` : '；无缺测日';
  const summary = `${metricLabel}近 ${days} 天：从 ${formatExactCount(prepared.first[metric])}（${formatBeijingDay(prepared.first.day)}）到 ${formatExactCount(prepared.last[metric])}（${formatBeijingDay(prepared.last.day)}），${directionText} ${formatExactCount(Math.abs(prepared.delta))}${gapText}`;

  return (
    <div className={cn('relative inline-flex items-center gap-2', className)}>
      <svg
        ref={svgRef}
        role="img"
        aria-label={summary}
        aria-describedby={focused ? descriptionId : undefined}
        tabIndex={0}
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="shrink-0 rounded-[4px] text-accent"
        onFocus={open}
        onBlur={close}
        onMouseEnter={open}
        onMouseLeave={close}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {areaSegments.map((coords, index) => (
          <polygon key={`area-${index}`} points={coords} fill={`url(#${gradientId})`} stroke="none" />
        ))}
        {lineSegments.map((coords, index) => (
          <polyline
            key={`line-${index}`}
            points={coords}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {prepared.visible.length <= 120
          ? positions.map((position) => (
              <circle
                key={position.point.day}
                cx={position.x}
                cy={position.y}
                r={1.4}
                fill="currentColor"
              />
            ))
          : null}
        {lastPosition !== undefined ? (
          <circle
            cx={lastPosition.x}
            cy={lastPosition.y}
            r={2.2}
            fill="currentColor"
            stroke="var(--gr-surface)"
            strokeWidth={1.5}
          />
        ) : null}
      </svg>
      <span className="inline-flex items-center gap-1 text-aux tabular-nums text-muted" aria-hidden="true">
        {direction === 'up' ? (
          <TrendingUp size={14} />
        ) : direction === 'down' ? (
          <TrendingDown size={14} />
        ) : null}
        {formatSignedCount(prepared.delta)}
      </span>
      {focused && anchor !== null
        ? createPortal(
            <div
              id={descriptionId}
              role="tooltip"
              style={
                // 优先向上弹出；锚点离视口顶不足 280px 时翻转到下方；
                // 左缘 8px 防溢出、右缘按 w-64(256px) 钳制在视口内。
                {
                  position: 'fixed',
                  left: Math.min(Math.max(8, anchor.left), window.innerWidth - 264),
                  ...(anchor.top > 280
                    ? { bottom: window.innerHeight - anchor.top + 8 }
                    : { top: anchor.bottom + 8 }),
                }
              }
              className="gr-card z-[100] w-64 p-2 text-aux text-text shadow-pop"
            >
              <p>
                {metricLabel}：{formatExactCount(prepared.first[metric])}（{formatBeijingDay(prepared.first.day)}）→{' '}
                {formatExactCount(prepared.last[metric])}（{formatBeijingDay(prepared.last.day)}）
              </p>
              <p className="text-muted">
                {directionText} {formatExactCount(Math.abs(prepared.delta))}；观测 {prepared.visible.length} 天
                {prepared.gaps > 0 ? `，${prepared.gaps} 处缺测日已断开` : ''}
              </p>
              <p className="text-muted">北京时间自然日分桶，非实时值。</p>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
