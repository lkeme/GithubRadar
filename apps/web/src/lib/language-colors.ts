/**
 * 语言色点：
 * 静态映射 GitHub linguist 的常见语言颜色，仅作视觉辅助，不承载状态语义；
 * 未收录的语言返回 null，由调用方回落到中性点。
 */

const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572a5',
  Rust: '#dea584',
  Go: '#00add8',
  Java: '#b07219',
  Kotlin: '#a97bff',
  Swift: '#f05138',
  'Objective-C': '#438eff',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4f5d95',
  Scala: '#c22d40',
  Shell: '#89e051',
  Lua: '#000080',
  Haskell: '#5e5086',
  Elixir: '#6e4a7e',
  Clojure: '#db5855',
  R: '#198ce7',
  Julia: '#a270ba',
  Zig: '#ec915c',
  Nix: '#7e7eff',
  Dart: '#00b4ab',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  HTML: '#e34c26',
  CSS: '#663399',
  Dockerfile: '#384d54',
  Makefile: '#427819',
  HCL: '#844fba',
  Markdown: '#083fa1',
};

export function languageColor(language: string | null | undefined): string | null {
  if (language === null || language === undefined) {
    return null;
  }
  return LANGUAGE_COLORS[language] ?? null;
}
