/**
 * 仓库聚合状态的唯一实现。
 *
 * 公开列表与管理详情必须使用同一套优先级，避免两处口径漂移：
 * paused → pending（尚无任何成功流）→ error（所有必要流均失败或身份失配）
 * → partial（部分失败/未初始化）→ stale（无已知失败但超时）→ healthy。
 *
 * “必要流”按运行时口径计算：metadata 恒必要；release/prerelease 跟随仓库开关；
 * 分支流只统计运行时派生的有效分支集合（与默认分支重名的固定分支已被排除，
 * 不参与聚合，也不把仓库拖进永久 stale）。
 */
export type RepositoryStatus = 'pending' | 'healthy' | 'partial' | 'stale' | 'error' | 'paused';

/** 聚合所需的最小流形状；调用方从各自的流读取映射而来。 */
export interface StatusStreamInput {
  readonly kind: string;
  readonly branchId: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastErrorCode: string | null;
}

export interface AggregateStatusInput {
  readonly enabled: boolean;
  readonly blockedReason: string | null;
  readonly verificationState: string;
  readonly releaseEnabled: boolean;
  readonly includePrereleases: boolean;
  /** 档位毫秒数（单仓覆盖或全局默认）。 */
  readonly intervalMs: number;
  readonly now: number;
  readonly streams: readonly StatusStreamInput[];
  /** 运行时派生的有效分支 ID 集合（collectableBranchIds 的结果）。 */
  readonly enabledBranchIds: ReadonlySet<number>;
}

/**
 * 判定聚合状态，优先级从高到低：
 * 用户暂停优先于系统阻塞显示（暂停的仓库不采集，blocked_reason 仍保留在详情里，
 * 不因展示顺序丢失）；身份失配等系统阻塞对启用中的仓库显示 error。
 */
export function aggregateRepositoryStatus(input: AggregateStatusInput): RepositoryStatus {
  if (!input.enabled) return 'paused';
  if (input.blockedReason !== null) return 'error';
  if (input.verificationState !== 'verified') return 'pending';

  const necessary = input.streams.filter((stream) => {
    if (stream.kind === 'branch') {
      return stream.branchId !== null && input.enabledBranchIds.has(stream.branchId);
    }
    if (stream.kind === 'release') return input.releaseEnabled;
    if (stream.kind === 'prerelease') return input.releaseEnabled && input.includePrereleases;
    return true;
  });
  if (necessary.length === 0) return 'pending';

  // 尚无任何成功流：还在初始化（含全部失败但从未成功——错误码在详情中可见）。
  if (necessary.every((stream) => stream.lastSuccessAt === null)) return 'pending';
  // 所有必要流最近一次尝试均失败（含成功过再次失败）：error 优先于 partial。
  if (necessary.every((stream) => stream.lastErrorCode !== null)) return 'error';
  if (necessary.some((stream) => stream.lastErrorCode !== null || stream.lastSuccessAt === null)) {
    return 'partial';
  }
  const staleBefore = input.now - 2 * input.intervalMs;
  if (necessary.some((stream) => (stream.lastSuccessAt ?? 0) < staleBefore)) return 'stale';
  return 'healthy';
}
