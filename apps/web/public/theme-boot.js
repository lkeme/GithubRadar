/*
 * 首帧主题引导。
 *
 * ThemeProvider 在 effect 里才写 <html data-theme>，而 effect 在首帧之后运行：
 * 显式偏好与系统主题不一致时会先按系统主题画一帧再翻转（白闪/黑闪）。这里在解析
 * head 阶段同步执行，把已保存的偏好写入 data-theme，React 随后读同一份 localStorage。
 *
 * 必须是同源外部脚本：CSP 的 script-src 只允许 'self'，内联脚本会被拦截。
 * 键名与取值必须与 lib/constants.ts、lib/storage.ts、lib/theme.tsx 保持一致。
 */
(function () {
  var STORAGE_KEY = 'githubradar:theme';
  var LIGHT_BG = '#f8fafc';
  var DARK_BG = '#0b1120';
  var preference = null;
  try {
    preference = window.localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    // 隐私模式等场景下读取会抛错，交由主题默认值处理。
    preference = null;
  }
  // system（含读取失败与非法取值）不需要显式标记：媒体查询已经给出正确的首帧。
  if (preference !== 'light' && preference !== 'dark') {
    return;
  }

  document.documentElement.setAttribute('data-theme', preference);

  // 显式偏好下浏览器界面色也要一致：带 media 的 theme-color 只跟随系统。
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var index = 0; index < metas.length; index += 1) {
    metas[index].remove();
  }
  var meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', preference === 'dark' ? DARK_BG : LIGHT_BG);
  document.head.appendChild(meta);
})();
