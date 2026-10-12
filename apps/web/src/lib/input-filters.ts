/**
 * 输入阶段的字符级过滤。
 *
 * 受限字段在键入时就只接受合法字符，而不是等到提交才报错；非法字符根本进不来，
 * 因此不会再出现"看起来填了、提交才被拒"的状态。服务端契约仍是唯一执行方，
 * 这里只负责把输入框约束在明显合法的形状上，不做任何语义判定。
 */

/** 端口：只保留数字（其余字符不进入输入框），并把超过 65535 的取值钳到上限。 */
export function filterPortInput(value: string): string {
  const digits = value.replace(/[^0-9]/g, '').slice(0, 5);
  if (digits === '') {
    return '';
  }
  return Number(digits) > 65_535 ? '65535' : digits;
}

/** 十六进制颜色：自动补 `#`，只保留 hex 字符（rgb 编码），最长 `#RRGGBBAA`。 */
export function filterHexColorInput(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, '').slice(0, 8);
  if (hex === '') {
    // 只留一个 "#" 时保留它：输入框不会在键入过程中把用户刚敲的字符吞掉。
    return value.includes('#') ? '#' : '';
  }
  return `#${hex}`;
}

/** 令牌等不允许空白的字段：粘贴时去掉换行与空格，而不是把整段判定为非法。 */
export function filterTokenInput(value: string): string {
  return value.replace(/\s+/g, '');
}
