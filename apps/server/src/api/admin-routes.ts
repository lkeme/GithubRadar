import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  BranchSelectionRequest,
  BulkActionRequest,
  CheckRequest,
  LabelCreateRequest,
  LabelUpdateRequest,
  PinsRequest,
  ProxyRequest,
  ProxyTestRequest,
  RepositoryImportRequest,
  RepositoryPatchRequest,
  SettingsUpdateRequest,
  TokenSubmitRequest,
  MAX_BATCH_IDS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} from '@githubradar/contracts';

import { AppError, isAppError, validationFailed } from '../http/errors.js';
import { registerRoute, type RoutePolicyGuard } from '../http/policy.js';
import type { RouteContext } from '../http/route-context.js';
import { parseBody, parseIfMatch, parseParams, parseQuery } from './validation.js';
import { parsePublicRepoId, publicRepoId } from '../domain/public.js';
import { activeJobsForRepositories, enabledRepositoryIds, readSettings } from '../scheduler/runner.js';
import {
  cancelJob,
  clearJobHistory,
  deleteJob,
  enqueueControlOperation,
  listJobs as listJobSummaries,
  requestBranchRefresh,
  requestTokenVerification,
  updateSettings as applySettingsUpdate,
} from './admin-support.js';

/**
 * 管理接口。
 *
 * - 认证与 CSRF 在策略层先执行，再检查 Token 就绪；未就绪时只放行白名单里的修复与诊断。
 * - 写接口使用严格 schema，缺前置版本 428、冲突 409。
 * - 所有管理响应 no-store，包括错误与 304 路径。
 */

const RepositoryParams = z.strictObject({ id: z.string().min(1).max(64) });
const GroupParams = z.strictObject({ id: z.string().min(1).max(64) });
const LabelParams = z.strictObject({ id: z.string().min(1).max(64) });
const OperationParams = z.strictObject({ id: z.string().min(1).max(64) });
const JobParams = z.strictObject({ id: z.string().min(1).max(64) });

const ControlsQuery = z.strictObject({ ids: z.string().min(1).max(2048) });
const BranchQuery = z.strictObject({
  page: z.string().regex(/^[1-9][0-9]*$/).optional(),
  pageSize: z.string().regex(/^[1-9][0-9]*$/).optional(),
});
const JobsQuery = z.strictObject({
  state: z.enum(['all', 'queued', 'running', 'retry_wait', 'succeeded', 'failed']).optional(),
  page: z.string().regex(/^[1-9][0-9]*$/).optional(),
  pageSize: z.string().regex(/^[1-9][0-9]*$/).optional(),
});

export function registerAdminRoutes(app: FastifyInstance, guard: RoutePolicyGuard, context: RouteContext): void {
  const adminWrite = { access: 'admin_write' } as const;
  // 只读诊断：admin_read 在策略层默认与写路径一样受 Token 门禁约束，
  // 这些路由只读取状态、不绕过任何业务写门禁（写操作仍被门禁拦住），
  // 因此逐条显式豁免，保证"未就绪也能看诊断"的现网行为不变。
  const adminRead = {
    access: 'admin_read',
    tokenGate: 'exempt',
    tokenGateExemptReason: 'read_only_diagnostics',
  } as const;
  const credentialRepair = {
    access: 'admin_write',
    tokenGate: 'exempt',
    tokenGateExemptReason: 'credential_repair',
  } as const;
  const proxyRepair = {
    access: 'admin_write',
    tokenGate: 'exempt',
    tokenGateExemptReason: 'proxy_repair',
  } as const;

  // ------------------------------------------------------------ 导入与仓库管理

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/admin/repository-imports',
    policy: adminWrite,
    handler: async (request, reply) => {
      const body = parseBody(request, RepositoryImportRequest);
      const result = context.repositoryService.importBatch(body.input, request.session?.authVersion ?? null);
      void reply.status(202).send({
        data: { groupId: String(result.groupId), jobIds: [], reused: false },
        meta: {},
      });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/repository-imports/:id',
    policy: adminRead,
    handler: async (request, reply) => {
      const params = parseParams(request, GroupParams);
      const groupId = requireDecimalId(params.id, '导入批次不存在');
      const progress = context.repositoryService.importProgress(groupId);
      if (progress === null) throw new AppError('NOT_FOUND', '导入批次不存在');
      void reply.status(200).send({
        data: { groupId: params.id, state: progress.state, total: progress.total, items: progress.items },
        meta: {},
      });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/repository-controls',
    policy: adminRead,
    handler: async (request, reply) => {
      const query = parseQuery(request, ControlsQuery);
      const ids = query.ids
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '')
        .map((value) => {
          const parsed = parsePublicRepoId(value);
          if (parsed === null) throw new AppError('VALIDATION_FAILED', `非法仓库 ID：${value}`);
          return parsed;
        });
      if (ids.length === 0 || ids.length > MAX_BATCH_IDS) {
        throw new AppError('VALIDATION_FAILED', `一次最多读取 ${MAX_BATCH_IDS} 个仓库`);
      }
      const rows = context.repositoryService.controls(ids);
      const jobStates = activeJobsForRepositories(context.db, ids);
      const setupRequired = !context.gate.isReady();
      void reply.status(200).send({
        data: rows.map((row) => ({
          id: publicRepoId(row.id),
          editRevision: row.editRevision,
          enabled: row.enabled,
          paused: !row.enabled,
          status: row.status,
          verificationState: row.verificationState,
          jobState: jobStates.get(row.id) ?? 'idle',
          capabilities: setupRequired
            ? { canCheck: false, canPause: false, canResume: false, canRemove: false, canEdit: false }
            : {
                // 门禁就绪不代表该仓库可检测：未验证占位与身份失配仓库的检测必然被拒，
                // 这里透传领域层算出的 canCheck，不能让界面出现一个注定失败的入口。
                canCheck: row.capabilities.canCheck,
                canPause: row.enabled,
                canResume: !row.enabled,
                canRemove: true,
                canEdit: true,
              },
        })),
        meta: { setupRequired },
      });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/repositories/:id',
    policy: adminRead,
    handler: async (request, reply) => {
      const repoId = requireRepoId(request.params);
      const detail = context.repositoryService.detail(repoId);
      if (detail === null) throw new AppError('NOT_FOUND', '仓库不存在');
      void reply.status(200).send({ data: detail, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'PATCH',
    url: '/api/v1/admin/repositories/:id',
    policy: adminWrite,
    handler: async (request, reply) => {
      const repoId = requireRepoId(request.params);
      const body = parseBody(request, RepositoryPatchRequest);
      context.repositoryService.patch(repoId, body);
      context.scheduler.notify();
      const detail = context.repositoryService.detail(repoId);
      if (detail === null) throw new AppError('NOT_FOUND', '仓库不存在');
      void reply.status(200).send({ data: detail, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'DELETE',
    url: '/api/v1/admin/repositories/:id',
    policy: adminWrite,
    handler: async (request, reply) => {
      const repoId = requireRepoId(request.params);
      const editRevision = parseIfMatch(request);
      context.repositoryService.remove(repoId, editRevision);
      context.scheduler.notify();
      void reply.status(204).send();
    },
  });

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/admin/repository-actions',
    policy: adminWrite,
    handler: async (request, reply) => {
      const body = parseBody(request, BulkActionRequest);
      const items = body.items.map((item) => {
        const parsed = parsePublicRepoId(item.id);
        if (parsed === null) throw new AppError('VALIDATION_FAILED', `非法仓库 ID：${item.id}`);
        return { id: parsed, editRevision: item.editRevision };
      });
      const results = context.repositoryService.applyBulk({
        action: body.action,
        items,
        labelIds: body.labelIds,
        sessionAuthVersion: request.session?.authVersion ?? 0,
      });
      context.scheduler.notify();
      void reply.status(200).send({
        data: {
          results: results.map((row) => ({
            id: publicRepoId(row.id),
            status: row.status,
            errorCode: row.errorCode,
          })),
        },
        meta: {},
      });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/repositories/:id/available-branches',
    policy: adminRead,
    handler: async (request, reply) => {
      const repoId = requireRepoId(request.params);
      const query = parseQuery(request, BranchQuery);
      const page = requireQueryNumber(query.page, 'page', 1);
      const pageSize = Math.min(requireQueryNumber(query.pageSize, 'pageSize', PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX);
      const result = context.repositoryService.readAvailableBranches(repoId, page, pageSize);
      void reply.status(200).send({
        data: result.items,
        meta: {
          page,
          pageSize,
          total: result.total,
          cacheStatus: result.cacheStatus,
          fetchedAt:
            result.fetchedAt === null
              ? null
              : new Date(result.fetchedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        },
      });
    },
  });

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/admin/repositories/:id/branch-refreshes',
    policy: adminWrite,
    handler: async (request, reply) => {
      const repoId = requireRepoId(request.params);
      const detail = context.repositoryService.detail(repoId);
      if (detail === null) throw new AppError('NOT_FOUND', '仓库不存在');
      const { jobId, reused } = requestBranchRefresh(context.db, context.scheduler.jobQueue, repoId, context.now());
      context.scheduler.notify();
      void reply.status(202).send({
        data: { groupId: null, jobIds: [String(jobId)], reused },
        meta: {},
      });
    },
  });

  registerRoute(app, guard, {
    method: 'PUT',
    url: '/api/v1/admin/repositories/:id/branches',
    policy: adminWrite,
    handler: async (request, reply) => {
      const repoId = requireRepoId(request.params);
      const body = parseBody(request, BranchSelectionRequest);
      context.repositoryService.replaceBranches(repoId, body.editRevision, body.branches);
      context.scheduler.notify();
      const detail = context.repositoryService.detail(repoId);
      if (detail === null) throw new AppError('NOT_FOUND', '仓库不存在');
      void reply.status(200).send({ data: detail, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/pins',
    policy: adminRead,
    handler: async (_request, reply) => {
      const settings = readSettings(context.db);
      const rows = context.db.$client
        .prepare('SELECT id FROM repositories WHERE pin_order IS NOT NULL ORDER BY pin_order, id')
        .all() as { id: number }[];
      void reply.status(200).send({
        data: { pinsRevision: settings.pinsRevision, ids: rows.map((row) => publicRepoId(row.id)) },
        meta: {},
      });
    },
  });

  registerRoute(app, guard, {
    method: 'PUT',
    url: '/api/v1/admin/pins',
    policy: adminWrite,
    handler: async (request, reply) => {
      const body = parseBody(request, PinsRequest);
      const ids = body.ids.map((value) => {
        const parsed = parsePublicRepoId(value);
        if (parsed === null) throw new AppError('VALIDATION_FAILED', `非法仓库 ID：${value}`);
        return parsed;
      });
      context.labelService.setPins(body.pinsRevision, ids);
      void reply.status(200).send({ data: {}, meta: {} });
    },
  });

  // ------------------------------------------------------------ 标签

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/labels',
    policy: adminRead,
    handler: async (_request, reply) => {
      void reply.status(200).send({ data: context.labelService.list(), meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/admin/labels',
    policy: adminWrite,
    handler: async (request, reply) => {
      const body = parseBody(request, LabelCreateRequest);
      const created = context.labelService.create(body.name, body.color ?? null);
      void reply.status(201).send({ data: created, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'PATCH',
    url: '/api/v1/admin/labels/:id',
    policy: adminWrite,
    handler: async (request, reply) => {
      const params = parseParams(request, LabelParams);
      const labelId = requireLabelId(params.id);
      const body = parseBody(request, LabelUpdateRequest);
      const updated = context.labelService.update(labelId, body.labelRevision, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.color === undefined ? {} : { color: body.color }),
      });
      void reply.status(200).send({ data: updated, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'DELETE',
    url: '/api/v1/admin/labels/:id',
    policy: adminWrite,
    handler: async (request, reply) => {
      const params = parseParams(request, LabelParams);
      // 删除标签定义同样走 If-Match 版本校验：缺版本 428、冲突 409。
      context.labelService.remove(requireLabelId(params.id), parseIfMatch(request));
      void reply.status(204).send();
    },
  });

  // ------------------------------------------------------------ 检测与任务

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/admin/checks',
    policy: adminWrite,
    handler: async (request, reply) => {
      const body = parseBody(request, CheckRequest);
      let repoIds: number[];
      if (body.scope === 'all') {
        // 在授权事务中物化当时运行仓库的 ID 集合；后续新增仓库不自动加入。
        repoIds = enabledRepositoryIds(context.db);
      } else {
        if (body.ids === undefined || body.ids.length === 0) {
          throw new AppError('VALIDATION_FAILED', 'selected 范围必须提供仓库 ID');
        }
        repoIds = body.ids.map((value) => {
          const parsed = publicId(value);
          if (parsed === null) throw new AppError('VALIDATION_FAILED', `非法仓库 ID：${value}`);
          return parsed;
        });
      }
      const jobIds: string[] = [];
      let skipped = 0;
      for (const repoId of repoIds) {
        try {
          for (const jobId of context.scheduler.scheduleManualCheck(repoId, 'manual')) {
            jobIds.push(String(jobId));
          }
        } catch (error) {
          // 身份失配、未验证等不可检测对象不创建任务；混合选择里仍然调度可用的仓库。
          // 逐项跳过必须留下可观测痕迹：内部错误（非 AppError 的拒绝）记入日志，
          // 不能与“不可检测”一起被静默吞掉。
          skipped += 1;
          if (isAppError(error)) {
            request.log.info({ repoId, code: error.code }, 'manual check skipped');
          } else {
            request.log.warn({ repoId, err: error }, 'manual check scheduling failed');
          }
        }
      }
      if (jobIds.length === 0 && skipped > 0) {
        throw new AppError('GITHUB_ACCESS_DENIED_OR_MISSING', '所选仓库当前都不可检测');
      }
      void reply.status(202).send({ data: { groupId: null, jobIds, reused: jobIds.length === 0 }, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/jobs',
    policy: adminRead,
    handler: async (request, reply) => {
      const query = parseQuery(request, JobsQuery);
      const page = requireQueryNumber(query.page, 'page', 1);
      const pageSize = Math.min(requireQueryNumber(query.pageSize, 'pageSize', PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX);
      const result = listJobSummaries(context.db, {
        state: query.state ?? 'all',
        page,
        pageSize,
      });
      void reply.status(200).send({
        data: result.items,
        meta: { page, pageSize, total: result.total },
      });
    },
  });

  registerRoute(app, guard, {
    method: 'DELETE',
    url: '/api/v1/admin/jobs',
    policy: adminWrite,
    handler: async (_request, reply) => {
      clearJobHistory(context.db);
      void reply.status(200).send({ data: {}, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/admin/jobs/:id/cancel',
    policy: adminWrite,
    handler: async (request, reply) => {
      const params = parseParams(request, JobParams);
      const jobId = requireDecimalId(params.id, '任务不存在');
      cancelJob(context.db, context.credentials, jobId, context.now());
      context.scheduler.notify();
      void reply.status(200).send({ data: {}, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'DELETE',
    url: '/api/v1/admin/jobs/:id',
    policy: adminWrite,
    handler: async (request, reply) => {
      const params = parseParams(request, JobParams);
      const jobId = requireDecimalId(params.id, '任务不存在');
      deleteJob(context.db, jobId);
      void reply.status(200).send({ data: {}, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/job-groups/:id',
    policy: adminRead,
    handler: async (request, reply) => {
      const params = parseParams(request, GroupParams);
      const groupId = requireDecimalId(params.id, '任务组不存在');
      const progress = context.repositoryService.importProgress(groupId);
      if (progress === null) throw new AppError('NOT_FOUND', '任务组不存在');
      void reply.status(200).send({
        data: { groupId: params.id, state: progress.state, total: progress.total, items: progress.items },
        meta: {},
      });
    },
  });

  // ------------------------------------------------------------ 设置

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/settings',
    policy: adminRead,
    handler: async (_request, reply) => {
      const settings = readSettings(context.db);
      void reply.status(200).send({
        data: {
          defaultIntervalHours: settings.defaultIntervalHours,
          discoveryEnabled: settings.discoveryEnabled,
          revision: settings.revision,
        },
        meta: {},
      });
    },
  });

  registerRoute(app, guard, {
    method: 'PUT',
    url: '/api/v1/admin/settings',
    policy: adminWrite,
    handler: async (request, reply) => {
      const body = parseBody(request, SettingsUpdateRequest);
      applySettingsUpdate(context.db, context.now(), body);
      context.scheduler.notify();
      const settings = readSettings(context.db);
      void reply.status(200).send({
        data: {
          defaultIntervalHours: settings.defaultIntervalHours,
          discoveryEnabled: settings.discoveryEnabled,
          revision: settings.revision,
        },
        meta: {},
      });
    },
  });

  // ------------------------------------------------------------ 凭证与代理修复

  registerRoute(app, guard, {
    method: 'PUT',
    url: '/api/v1/admin/github-token',
    policy: credentialRepair,
    handler: async (request, reply) => {
      const session = request.session;
      if (session === undefined) throw new AppError('UNAUTHENTICATED', '需要管理员会话');
      const body = parseBody(request, TokenSubmitRequest);
      const operationId = context.credentials.submitToken(session, body.token);
      enqueueControlOperation(context.scheduler.jobQueue, 'token_verify', operationId, context.now());
      context.scheduler.notify();
      void reply.status(202).send({ data: { operationId: String(operationId) }, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/github-token/status',
    policy: adminRead,
    handler: async (_request, reply) => {
      const status = context.credentials.status();
      const budgetState = context.budgetState();
      void reply.status(200).send({
        data: {
          configured: status.configured,
          state: status.effectiveState,
          connectivity: status.connectivity,
          lastVerifiedAt: iso(status.lastVerifiedAt),
          expiresAt: iso(status.expiresAt),
          lastErrorCode: status.lastErrorCode,
          rateLimit:
            budgetState.remaining === null && budgetState.limit === null
              ? null
              : {
                  resource: budgetState.resource,
                  limit: budgetState.limit,
                  remaining: budgetState.remaining,
                  resetAt: iso(budgetState.resetAt),
                  observedAt: iso(budgetState.observedAt),
                  sharedWithAccount: true as const,
                },
        },
        meta: {},
      });
    },
  });

  // 重置 Token：清除密文并把凭证状态复位为 missing，业务回到门禁锁定，
  // 直到重新提交并在线验证。属于凭证修复通路，门禁未就绪时也可执行。
  registerRoute(app, guard, {
    method: 'DELETE',
    url: '/api/v1/admin/github-token',
    policy: credentialRepair,
    handler: async (_request, reply) => {
      context.credentials.clearToken();
      context.scheduler.notify();
      void reply.status(200).send({ data: {}, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/admin/github-token/verify',
    policy: credentialRepair,
    handler: async (_request, reply) => {
      if (!context.credentials.status().configured) {
        // 不能对缺失凭证自行生成匿名请求。
        throw new AppError('GITHUB_TOKEN_REQUIRED', '尚未配置 PAT，无法重新验证');
      }
      const jobId = requestTokenVerification(context.scheduler.jobQueue, context.now());
      context.scheduler.notify();
      void reply.status(202).send({ data: { operationId: `job_${String(jobId)}` }, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/proxy',
    policy: adminRead,
    handler: async (_request, reply) => {
      void reply.status(200).send({ data: context.credentials.readProxy(), meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'PUT',
    url: '/api/v1/admin/proxy',
    policy: proxyRepair,
    handler: async (request, reply) => {
      const session = request.session;
      if (session === undefined) throw new AppError('UNAUTHENTICATED', '需要管理员会话');
      const body = parseBody(request, ProxyRequest);

      if (!body.enabled) {
        // 关闭代理是管理员明确选择，不是失败后的静默 fallback。
        context.credentials.disableProxy(body.expectedRevision);
        context.scheduler.notify();
        void reply.status(200).send({ data: context.credentials.readProxy(), meta: {} });
        return;
      }
      if (body.scheme === undefined || body.scheme === null || body.host === undefined || body.host === null || body.port === undefined || body.port === null) {
        throw new AppError('VALIDATION_FAILED', '启用代理必须提供 scheme、host 与 port');
      }
      const operationId = context.credentials.submitProxyApply(
        session,
        {
          scheme: body.scheme,
          host: body.host,
          port: body.port,
          username: body.username ?? null,
          password: body.password ?? null,
        },
        body.expectedRevision,
      );
      // 候选代理“测试并保存”：探测由 proxy_test 控制任务执行，
      // 成功后才在 applyProxyResult 里原子替换活动配置。
      enqueueControlOperation(context.scheduler.jobQueue, 'proxy_test', operationId, context.now());
      context.scheduler.notify();
      void reply.status(202).send({ data: { operationId: String(operationId) }, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/admin/proxy/test',
    policy: proxyRepair,
    handler: async (request, reply) => {
      const session = request.session;
      if (session === undefined) throw new AppError('UNAUTHENTICATED', '需要管理员会话');
      const body = parseBody(request, ProxyTestRequest);
      const operationId = context.credentials.submitProxyTest(session, {
        scheme: body.scheme,
        host: body.host,
        port: body.port,
        username: body.username ?? null,
        password: body.password ?? null,
      });
      enqueueControlOperation(context.scheduler.jobQueue, 'proxy_test', operationId, context.now());
      context.scheduler.notify();
      void reply.status(202).send({ data: { operationId: String(operationId) }, meta: {} });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/operations/:id',
    policy: adminRead,
    handler: async (request, reply) => {
      const params = parseParams(request, OperationParams);
      const operation = context.credentials.readOperation(params.id);
      if (operation === null) throw new AppError('NOT_FOUND', '操作不存在');
      void reply.status(200).send({
        data: {
          id: String(operation.id),
          kind: operation.kind,
          status: operation.status,
          errorCode: operation.errorCode,
          createdAt: iso(operation.createdAt),
          expiresAt: iso(operation.expiresAt),
          result: parseOperationResult(operation.resultJson),
        },
        meta: {},
      });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/admin/system-status',
    policy: adminRead,
    handler: async (_request, reply) => {
      void reply.status(200).send({ data: context.systemStatus(), meta: {} });
    },
  });
}

function requireRepoId(params: unknown): number {
  const parsed = RepositoryParams.safeParse(params);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '路径参数非法');
  const repoId = publicId(parsed.data.id);
  if (repoId === null) throw new AppError('NOT_FOUND', '仓库不存在');
  return repoId;
}

/** 分页参数上限：page 超过它只会放大 OFFSET，不存在真实页面。 */
const MAX_PAGE = 1_000_000;

/**
 * 数字 query 参数（page/pageSize）。
 *
 * Zod 的十进制正则挡不住超长数字串：`Number('99999999999999999999')` 是安全整数之外的浮点，
 * 直接带进 OFFSET 会让 better-sqlite3 抛越界错误，表现为 500。这里统一：
 * 纯十进制写法 → 安全整数 → 上限，非法输入在边界返回 400（fields 指出参数名）。
 */
function requireQueryNumber(raw: string | undefined, field: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw validationFailed({ [field]: '必须是十进制正整数' });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_PAGE) {
    throw validationFailed({ [field]: `不能大于 ${String(MAX_PAGE)}` });
  }
  return value;
}

/**
 * 数字路径参数：同样只接受纯十进制安全整数，
 * `1e3`、`0x10` 这类 Number 能解析的写法一律按"资源不存在"处理（与仓库 ID 的写法一致）。
 */
function requireDecimalId(raw: string, message: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new AppError('NOT_FOUND', message);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new AppError('NOT_FOUND', message);
  return value;
}

function requireLabelId(value: string): number {
  const match = /^label_(\d+)$/.exec(value);
  if (match === null) throw new AppError('NOT_FOUND', '标签不存在');
  return Number(match[1]);
}

function publicId(value: string): number | null {
  return parsePublicRepoId(value);
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseOperationResult(resultJson: string | null): {
  probeStages: unknown[] | null;
  credentialState: string | null;
} | null {
  if (resultJson === null) return null;
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    return {
      probeStages: Array.isArray(parsed['probeStages']) ? (parsed['probeStages'] as unknown[]) : null,
      credentialState: typeof parsed['credentialState'] === 'string' ? parsed['credentialState'] : null,
    };
  } catch {
    return null;
  }
}
