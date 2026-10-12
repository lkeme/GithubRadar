/**
 * 标签 ID 空间转换：标签列表与仓库详情返回 `label_<id>` 字符串（服务端 publicLabelId），
 * 而 PATCH labelIds / 批量标签动作按契约要求正整数数组。
 * 非法引用不提交，避免把 NaN 写进请求体。
 */
export function toLabelIdNumbers(ids: string[]): number[] {
  const numbers: number[] = [];
  for (const id of ids) {
    const match = /^(?:label_)?(\d+)$/.exec(id);
    if (match === null || match[1] === undefined) {
      continue;
    }
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > 0) {
      numbers.push(parsed);
    }
  }
  return numbers;
}
