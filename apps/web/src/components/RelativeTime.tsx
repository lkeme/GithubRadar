import { serverNow, useNowTick } from '../lib/clock';
import { describeDelta, describeScheduledDelta, formatAbsolute, formatDescribedDelta, parseIso } from '../lib/relative-time';
import { cn } from './ui/cn';

export interface RelativeTimeProps {
  iso: string | null | undefined;
  /** 前缀文案，如“发布于”“提交于”“检查于”。 */
  prefix?: string;
  emptyText?: string;
  className?: string;
  /**
   * 计划/到期类时间（下次复核、配额重置、任务到期、退避截止）置 true：
   * 未来值正常显示“X 后”；“时间异常”判定只针对上游来源时间，不适用于计划时间。
   */
  future?: boolean;
}

/**
 * 相对时间：
 * - 用校正后的服务器时间计算，每分钟与页面恢复可见时重算（useNowTick）。
 * - 使用 <time datetime>，聚焦可查看准确时间（title + aria-label）。
 * - 未知时间显示“—”，来源时间的未来超容差显示“时间异常”。
 */
export function RelativeTime({ iso, prefix, emptyText = '—', className, future = false }: RelativeTimeProps) {
  useNowTick();
  const target = parseIso(iso);
  if (!Number.isFinite(target)) {
    return <span className={cn('text-muted', className)}>{emptyText}</span>;
  }
  const now = serverNow();
  const described = future ? describeScheduledDelta(target, now) : describeDelta(target, now);
  const text = formatDescribedDelta(described);
  const absolute = formatAbsolute(target);
  const withPrefix = prefix !== undefined && described.kind !== 'anomaly' ? `${prefix}${text}` : text;
  const accessible = described.kind === 'anomaly' ? `时间异常（原值 ${absolute}）` : `${withPrefix}，准确时间 ${absolute}`;
  return (
    <time
      dateTime={iso ?? undefined}
      tabIndex={0}
      title={absolute}
      aria-label={accessible}
      className={cn('inline-block rounded-[4px]', className)}
    >
      {withPrefix}
    </time>
  );
}
