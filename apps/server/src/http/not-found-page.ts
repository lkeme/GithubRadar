/**
 * 未知页面路径的 404 响应（未知路径不返回空白页）。
 *
 * 直接命中未知 URL 时由服务端返回，与 SPA 内客户端路由的 NotFoundPage 分工不同；
 * 自包含内联样式（CSP style-src 允许 unsafe-inline），不加载任何外部资源、不嵌入动态数据。
 * 调色板与基线一致，明暗随系统；雷达同心环为静态装饰。
 */
export const NOT_FOUND_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="referrer" content="no-referrer" />
    <title>页面不存在 · Github雷达</title>
    <style>
      :root {
        --bg: #f8fafc;
        --grid: rgb(15 23 42 / 0.028);
        --surface: #ffffff;
        --text: #0f172a;
        --muted: #475569;
        --border: #e2e8f0;
        --accent: #1d4ed8;
        --accent-strong: #1e40af;
        --accent-contrast: #ffffff;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0b1120;
          --grid: rgb(148 163 184 / 0.05);
          --surface: #111827;
          --text: #f1f5f9;
          --muted: #94a3b8;
          --border: #2a3648;
          --accent: #93c5fd;
          --accent-strong: #bfdbfe;
          --accent-contrast: #0b1120;
        }
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100dvh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background-color: var(--bg);
        background-image:
          linear-gradient(to right, var(--grid) 1px, transparent 1px),
          linear-gradient(to bottom, var(--grid) 1px, transparent 1px);
        background-size: 40px 40px;
        color: var(--text);
        font-family:
          ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
          'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      main {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        text-align: center;
        max-width: 24rem;
      }
      .rings {
        position: absolute;
        left: 50%;
        top: 28px;
        width: 320px;
        height: 320px;
        transform: translate(-50%, -50%);
        color: var(--accent);
        opacity: 0.55;
        pointer-events: none;
      }
      .code {
        margin: 0;
        font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.2em;
        color: var(--accent);
      }
      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.25;
        font-weight: 600;
        letter-spacing: -0.015em;
      }
      p {
        margin: 0;
        max-width: 20rem;
        font-size: 14px;
        line-height: 1.6;
        color: var(--muted);
      }
      a {
        margin-top: 14px;
        display: inline-flex;
        align-items: center;
        height: 36px;
        padding: 0 18px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
        color: var(--text);
        font-size: 14px;
        font-weight: 500;
        text-decoration: none;
      }
      a:hover {
        border-color: var(--accent);
        color: var(--accent);
      }
      a:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
    </style>
  </head>
  <body>
    <main>
      <svg class="rings" viewBox="0 0 480 480" fill="none" aria-hidden="true">
        <circle cx="240" cy="240" r="70" stroke="currentColor" stroke-opacity="0.16" />
        <circle cx="240" cy="240" r="120" stroke="currentColor" stroke-opacity="0.16" />
        <circle cx="240" cy="240" r="170" stroke="currentColor" stroke-opacity="0.16" />
        <circle cx="240" cy="240" r="220" stroke="currentColor" stroke-opacity="0.16" stroke-dasharray="2 6" />
        <line x1="240" y1="240" x2="396" y2="84" stroke="currentColor" stroke-opacity="0.28" />
        <circle cx="396" cy="84" r="3" fill="currentColor" fill-opacity="0.5" />
      </svg>
      <p class="code">404</p>
      <h1>页面不存在</h1>
      <p>地址可能输入有误，或该页面已被移除。</p>
      <a href="/">返回看板</a>
    </main>
  </body>
</html>
`;
