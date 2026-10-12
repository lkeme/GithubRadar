import type { CSSProperties } from 'react';

/**
 * 雷达同心环装饰（静态：不做雷达扫描动画）：
 * 用于登录页与 404 页的品牌性背景装饰，极低对比度，不承载信息。
 */
export function RadarRings({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 480 480"
      fill="none"
      className={className}
      style={style}
    >
      {[70, 120, 170, 220].map((radius) => (
        <circle
          key={radius}
          cx="240"
          cy="240"
          r={radius}
          stroke="currentColor"
          strokeOpacity={0.16}
          strokeWidth={1}
          strokeDasharray={radius === 220 ? '2 6' : undefined}
        />
      ))}
      {/* 静态方位刻度：四个基点短线。 */}
      {[
        [240, 26, 240, 40],
        [240, 440, 240, 454],
        [26, 240, 40, 240],
        [440, 240, 454, 240],
      ].map(([x1, y1, x2, y2]) => (
        <line key={`${x1}-${y1}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeOpacity={0.22} strokeWidth={1} />
      ))}
      {/* 静态扫描线（一条，不旋转）：指向 45°。 */}
      <line x1="240" y1="240" x2="396" y2="84" stroke="currentColor" strokeOpacity={0.28} strokeWidth={1} />
      <circle cx="396" cy="84" r="3" fill="currentColor" fillOpacity={0.5} />
    </svg>
  );
}
