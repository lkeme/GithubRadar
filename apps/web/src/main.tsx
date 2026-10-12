import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import './styles/index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('缺少 #root 挂载容器');
}

/**
 * 指针焦点标记（全局 UX 管线）：
 * 指针交互后，Radix 菜单/下拉关闭会把焦点还给 trigger（脚本回焦），
 * 浏览器会给这类回焦画 :focus-visible 焦点环、并触发 focus 型 Tooltip——
 * 对鼠标用户是“残留”。这里在指针按下时给 <html> 打 data-focus-source="pointer"，
 * 键盘导航键（Tab/方向/Enter/空格等）按下即移除；CSS 据此隐藏指针上下文里的
 * 焦点环，TooltipHint 据此不因回焦打开。Escape 不清除标记：鼠标打开的菜单
 * 用 Escape 关闭仍属指针上下文；纯键盘路径（Enter 打开）从未设置标记，不受影响。
 */
const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
]);
document.addEventListener(
  'pointerdown',
  () => {
    document.documentElement.dataset['focusSource'] = 'pointer';
  },
  { capture: true },
);
document.addEventListener(
  'keydown',
  (event) => {
    if (NAVIGATION_KEYS.has(event.key)) {
      delete document.documentElement.dataset['focusSource'];
    }
  },
  { capture: true },
);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
