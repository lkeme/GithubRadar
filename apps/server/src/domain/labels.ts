import { and, eq, sql } from 'drizzle-orm';

import { MAX_LABEL_NAME_LENGTH, isValidLabelColor, LABEL_COLOR_INVALID } from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import { labels, repositories, repositoryLabels, settings } from '../db/schema.js';
import { AppError, validationFailed } from '../http/errors.js';
import type { JobQueue } from '../scheduler/queue.js';
import { withImmediateTransaction } from './branches.js';

/**
 * 分类标签定义与置顶。
 *
 * - 标签与 Git Tag 无关；编辑带 `labelRevision`：缺版本 428、冲突 409。
 * - 置顶使用 `settings.pins_revision` 独立版本；顺序 `pin_order` 从 1 开始，
 *   未列出的仓库清空置顶。置顶只改变展示顺序，不改变采集频率或配额。
 * - 行结构按契约 `LabelDefinition` 投影（id 为不透明字符串），便于管理接口直接透出。
 */

export interface LabelDomainDeps {
  readonly db: Database;
  readonly now: () => number;
  /** 装配层注入；标签与置顶操作本身不创建任务，与仓库领域依赖保持同形。 */
  readonly queue?: JobQueue;
}

export interface LabelRow {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly labelRevision: number;
  readonly usedByRepositories: number;
}

export interface LabelUpdateInput {
  readonly name?: string;
  readonly color?: string | null;
}

/** 标签的公开不透明 ID（与公开读投影一致）。 */
export function publicLabelId(id: number): string {
  return `label_${id}`;
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (name === '') throw validationFailed({ name: '标签名不能为空' });
  if ([...name].length > MAX_LABEL_NAME_LENGTH) {
    throw validationFailed({ name: `标签名最多 ${MAX_LABEL_NAME_LENGTH} 个字符` });
  }
  return name;
}

function normalizeColor(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const color = raw.trim();
  if (color === '') return null;
  if (color.length > 32) throw validationFailed({ color: '颜色值最多 32 个字符' });
  // 与服务端契约共用同一规则：只接受 #RGB/#RRGGBB/#RRGGBBAA，避免把无效值写进库后在前端被静默忽略。
  if (!isValidLabelColor(color)) {
    throw validationFailed({ color: LABEL_COLOR_INVALID });
  }
  return color;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message);
}

/**
 * 置顶顺序替换（PUT /admin/pins）：
 * 事务内比较 `pins_revision`，整表替换 `pin_order`；置顶改变递增相关仓库的
 * edit_revision / display_revision，不动采集基线与档位。
 */
export function replacePins(db: Database, pinsRevision: number | undefined, ids: readonly number[]): void {
  if (pinsRevision === undefined || pinsRevision === null) {
    throw new AppError('REVISION_REQUIRED', '缺少 pinsRevision');
  }
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) throw validationFailed({ ids: '包含非法的仓库 ID' });
    if (seen.has(id)) throw validationFailed({ ids: '包含重复的仓库 ID' });
    seen.add(id);
  }

  withImmediateTransaction(db, () => {
    const claimed = db
      .update(settings)
      .set({ pinsRevision: sql`${settings.pinsRevision} + 1` })
      .where(and(eq(settings.id, 1), eq(settings.pinsRevision, pinsRevision)))
      .run();
    if (claimed.changes === 0) {
      throw new AppError('REVISION_CONFLICT', '置顶顺序已被其他编辑修改，请刷新后重试');
    }

    const target = new Map<number, number>();
    ids.forEach((id, index) => target.set(id, index + 1));

    // 仓库总量最多 999 行，一次性读取即可在该事务内完成比较与更新。
    const current = db
      .select({ id: repositories.id, pinOrder: repositories.pinOrder })
      .from(repositories)
      .all();
    const known = new Set(current.map((row) => row.id));
    for (const id of seen) {
      if (!known.has(id)) throw validationFailed({ ids: '包含不存在的仓库 ID' });
    }

    for (const row of current) {
      const next = target.get(row.id) ?? null;
      if (row.pinOrder === next) continue;
      db.update(repositories)
        .set({
          pinOrder: next,
          editRevision: sql`${repositories.editRevision} + 1`,
          displayRevision: sql`${repositories.displayRevision} + 1`,
        })
        .where(eq(repositories.id, row.id))
        .run();
    }
  });
}

export class LabelService {
  readonly #deps: LabelDomainDeps;

  constructor(deps: LabelDomainDeps) {
    this.#deps = deps;
  }

  /** 完整可编辑标签及 labelRevision，包含尚未被任何仓库使用的标签。 */
  list(): LabelRow[] {
    const rows = this.#deps.db.$client
      .prepare(
        `SELECT l.id, l.name, l.color, l.label_revision,
                (SELECT COUNT(*) FROM repository_labels rl WHERE rl.label_id = l.id) AS used
           FROM labels l
          ORDER BY l.name COLLATE NOCASE, l.id`,
      )
      .all() as { id: number; name: string; color: string | null; label_revision: number; used: number }[];
    return rows.map((row) => ({
      id: publicLabelId(row.id),
      name: row.name,
      color: row.color,
      labelRevision: row.label_revision,
      usedByRepositories: row.used,
    }));
  }

  create(name: string, color: string | null = null): LabelRow {
    const db = this.#deps.db;
    const normalizedName = normalizeName(name);
    const normalizedColor = normalizeColor(color);
    try {
      return withImmediateTransaction(db, () => {
        const inserted = db
          .insert(labels)
          .values({ name: normalizedName, color: normalizedColor, labelRevision: 1 })
          .returning({ id: labels.id })
          .all();
        const id = inserted[0]?.id;
        if (id === undefined) throw new Error('创建标签失败');
        return {
          id: publicLabelId(id),
          name: normalizedName,
          color: normalizedColor,
          labelRevision: 1,
          usedByRepositories: 0,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw validationFailed({ name: '标签名称已存在' });
      throw error;
    }
  }

  update(id: number, labelRevision: number, patch: LabelUpdateInput): LabelRow {
    if (labelRevision === undefined || labelRevision === null) {
      throw new AppError('REVISION_REQUIRED', '缺少 labelRevision');
    }
    const db = this.#deps.db;
    const nextName = patch.name === undefined ? undefined : normalizeName(patch.name);
    const nextColor = patch.color === undefined ? undefined : normalizeColor(patch.color);
    try {
      return withImmediateTransaction(db, () => {
        const row = db.select().from(labels).where(eq(labels.id, id)).get();
        if (row === undefined) throw new AppError('NOT_FOUND', '标签不存在');
        if (row.labelRevision !== labelRevision) {
          throw new AppError('REVISION_CONFLICT', '标签已被其他编辑修改，请刷新后重试');
        }
        const claimed = db
          .update(labels)
          .set({
            ...(nextName === undefined ? {} : { name: nextName }),
            ...(nextColor === undefined ? {} : { color: nextColor }),
            labelRevision: labelRevision + 1,
          })
          .where(and(eq(labels.id, id), eq(labels.labelRevision, labelRevision)))
          .run();
        if (claimed.changes === 0) {
          throw new AppError('REVISION_CONFLICT', '标签已被其他编辑修改，请刷新后重试');
        }
        const used = db
          .select({ count: sql<number>`COUNT(*)` })
          .from(repositoryLabels)
          .where(eq(repositoryLabels.labelId, id))
          .get();
        return {
          id: publicLabelId(id),
          name: nextName ?? row.name,
          color: nextColor === undefined ? row.color : nextColor,
          labelRevision: labelRevision + 1,
          usedByRepositories: used?.count ?? 0,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw validationFailed({ name: '标签名称已存在' });
      throw error;
    }
  }

  /**
   * 删除标签定义。仍被仓库使用的标签**不允许删除**：先在各仓库上解除关联，
   * 再删除定义；删除同样要求前置版本，在同一个 `BEGIN IMMEDIATE` 短事务里
   * 读取行、比较 `label_revision` 再删除，缺 428、不符 409，避免用旧界面覆盖他人的改名。
   */
  remove(id: number, labelRevision?: number): void {
    if (labelRevision === undefined || labelRevision === null) {
      throw new AppError('REVISION_REQUIRED', '缺少 labelRevision');
    }
    const db = this.#deps.db;
    withImmediateTransaction(db, () => {
      const current = db.select().from(labels).where(eq(labels.id, id)).get();
      if (current === undefined) throw new AppError('NOT_FOUND', '标签不存在');
      if (current.labelRevision !== labelRevision) {
        throw new AppError('REVISION_CONFLICT', '标签已被其他编辑修改，请刷新后重试');
      }
      const used = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(repositoryLabels)
        .where(eq(repositoryLabels.labelId, id))
        .get();
      if ((used?.count ?? 0) > 0) {
        throw new AppError('LABEL_IN_USE', `标签「${current.name}」仍被 ${used?.count ?? 0} 个仓库使用，先解除关联再删除`);
      }
      const deleted = db
        .delete(labels)
        .where(and(eq(labels.id, id), eq(labels.labelRevision, labelRevision)))
        .run();
      if (deleted.changes === 0) {
        throw new AppError('REVISION_CONFLICT', '标签已被其他编辑修改，请刷新后重试');
      }
    });
  }

  /** 置顶顺序列表；`setPins` 与 `replacePins` 为同一实现的两个入口。 */
  setPins(pinsRevision: number | undefined, ids: readonly number[]): void {
    replacePins(this.#deps.db, pinsRevision, ids);
  }
}
