import type { SystemStatusResponse } from '@githubradar/contracts';

import type { RequestContext } from './policy.js';
import type { CredentialService } from '../credentials/service.js';
import type { RepositoryService } from '../domain/repositories.js';
import type { LabelService } from '../domain/labels.js';
import type { Scheduler } from '../scheduler/runner.js';
import type { BudgetState } from '../scheduler/budget.js';

/**
 * 路由处理器共享的依赖容器。
 *
 * 只使用类型导入，因此不会与 `app.ts` 形成运行时循环：路由模块依赖这里的形状，
 * `app.ts` 负责实例化，装配入口仍然只有一个。
 */
export interface RouteContext extends RequestContext {
  readonly credentials: CredentialService;
  readonly repositoryService: RepositoryService;
  readonly labelService: LabelService;
  readonly scheduler: Scheduler;
  readonly authVersion: () => number;
  readonly budgetState: () => BudgetState;
  readonly systemStatus: () => SystemStatusResponse['data'];
}
