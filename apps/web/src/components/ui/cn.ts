/** 轻量 className 组合工具（不引入额外依赖）。 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}
