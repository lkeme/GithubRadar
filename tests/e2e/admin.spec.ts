import { expect, test } from '@playwright/test';

import { E2E_PASSWORD } from '../playwright.config.js';

/**
 * 管理流程端到端验收。
 *
 * 运行的是真实服务端与真实数据库（由 `e2e/start-server.mjs` 写入可复核的合成种子数据，
 * 全程不访问 GitHub）。因此这里验证的是「界面 + 服务端策略」的真实组合，
 * 而不是按钮可见性。
 */

/** 顶栏在窄屏用图标按钮、宽屏用文字按钮展示同一个动作，这里总是点可见的那个。 */
function visibleButton(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('button', { name }).filter({ visible: true }).first();
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await visibleButton(page, '登录').click();
  await page.getByLabel('密码', { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).last().click();
  // 账户菜单只在登录后出现，是唯一可靠的登录完成信号（宽窄屏都唯一）。
  await expect(page.getByRole('button', { name: '账户菜单' })).toBeVisible({ timeout: 15_000 });
}

/** 移除监控在宽屏是工具栏按钮，窄屏收进“动作”菜单；两种布局都要能走到同一个确认框。 */
async function openRemoveDialog(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  const direct = page.getByRole('button', { name: '移除所选仓库的监控' });
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
  } else {
    await visibleButton(page, '动作').click();
    await page.getByRole('menuitem', { name: '移除监控' }).click();
  }
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('公开看板内容', () => {
  test('展示已验证仓库的公开字段，私有仓库同样可见', async ({ page }) => {
    await page.goto('/');
    // 私有仓库的展示字段同样公开是已确认的产品策略。
    await expect(page.getByText('活跃示例').first()).toBeVisible();
    await expect(page.getByText('quiet-library').first()).toBeVisible();
    await expect(page.getByText('paused-tool').first()).toBeVisible();
  });

  test('暂停仓库仍出现在看板并带暂停标记', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('paused-tool').first()).toBeVisible();
  });

  test('切换紧凑列表后核心字段仍在', async ({ page }) => {
    await page.goto('/');
    const toggle = visibleButton(page, '紧凑列表视图');
    await toggle.click();
    await expect(page.getByText('活跃示例').first()).toBeVisible();
    await expect(page.getByText('v2.4.0').first()).toBeVisible();
  });

  test('公开页面不出现任何 Token 或管理信息', async ({ page }) => {
    await page.goto('/');
    const body = (await page.locator('body').innerText()).toLowerCase();
    for (const forbidden of ['ghp_', 'github_pat_', 'editrevision', 'credential']) {
      expect(body.includes(forbidden), forbidden).toBe(false);
    }
  });
});

test.describe('登录与退出', () => {
  test('登录后管理入口出现，退出后回到只读', async ({ page }) => {
    await login(page);
    await expect(page.getByRole('button', { name: '账户菜单' })).toBeVisible();

    await page.getByRole('button', { name: '账户菜单' }).click();
    await page.getByRole('menuitem', { name: '退出登录' }).click();
    await expect(page.getByRole('button', { name: '账户菜单' })).toHaveCount(0, { timeout: 15_000 });
    await expect(visibleButton(page, '登录')).toBeVisible();
  });

  test('登录弹窗保持当前筛选与分页上下文', async ({ page }) => {
    await page.goto('/?q=active');
    await visibleButton(page, '登录').click();
    await page.getByLabel('密码', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await expect(page.getByRole('button', { name: '账户菜单' })).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain('q=active');
  });

  test('多标签：一个标签退出后另一个标签复核并降级为只读', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await login(pageA);

    await pageB.goto('/');
    await expect(pageB.getByRole('button', { name: '账户菜单' })).toBeVisible({ timeout: 15_000 });

    await pageA.getByRole('button', { name: '账户菜单' }).click();
    await pageA.getByRole('menuitem', { name: '退出登录' }).click();
    await expect(pageA.getByRole('button', { name: '账户菜单' })).toHaveCount(0, { timeout: 15_000 });

    // 广播只是提示，另一个标签必须向服务器确认后再撤下管理入口。
    await pageB.bringToFront();
    await pageB.reload();
    await expect(pageB.getByRole('button', { name: '账户菜单' })).toHaveCount(0, { timeout: 15_000 });
    await expect(pageB.getByText('sample/active-project').first()).toBeVisible();

    await pageA.close();
    await pageB.close();
  });

  test('returnTo 外站变体被拒绝，登录后仍留在站内', async ({ page }) => {
    for (const variant of ['//evil.com', 'https://evil.com', '/\\evil.com', '/%5Cevil.com']) {
      await page.goto(`/login?returnTo=${encodeURIComponent(variant)}`);
      // 变体被 safeReturnTo 归一到站内根路径；登录页必须先出现而不是直接外跳。
      await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
      const origin = new URL(page.url()).origin;

      await page.getByLabel('密码', { exact: true }).fill(E2E_PASSWORD);
      await page.getByRole('button', { name: '登录', exact: true }).last().click();
      await expect(page.getByRole('button', { name: '账户菜单' })).toBeVisible({ timeout: 15_000 });

      expect(new URL(page.url()).origin).toBe(origin);
      expect(new URL(page.url()).pathname).toBe('/');

      await page.getByRole('button', { name: '账户菜单' }).click();
      await page.getByRole('menuitem', { name: '退出登录' }).click();
      await expect(page.getByRole('button', { name: '账户菜单' })).toHaveCount(0, { timeout: 15_000 });
    }
  });

  test('未登录访问设置页：登录后回到 /settings，嵌套 returnTo 不导致外跳', async ({ page }) => {
    await page.goto('/settings?returnTo=//evil.com');
    await expect.poll(() => page.url()).toContain('/login');
    const loginUrl = new URL(page.url());
    const origin = loginUrl.origin;
    // RequireAuth 保留原始站内路径与查询参数，由 safeReturnTo 在登录后重新校验。
    expect(loginUrl.searchParams.get('returnTo')).toBe('/settings?returnTo=//evil.com');

    await page.getByLabel('密码', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/settings');
    expect(new URL(page.url()).origin).toBe(origin);
    await expect(page.getByText(/GitHub Token|Token 状态/).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('批量选择边界', () => {
  test('仅当前页选择，切换视图保留选择，切换筛选清空选择', async ({ page }) => {
    await login(page);
    await visibleButton(page, '批量选择').click();

    const checkboxes = page.getByRole('checkbox');
    expect(await checkboxes.count()).toBeGreaterThan(0);
    await checkboxes.first().check();
    await expect(page.getByText(/已选 1 项/)).toBeVisible();

    // 卡片/列表切换保留同页选择。
    await visibleButton(page, '紧凑列表视图').click();
    await expect(page.getByText(/已选 1 项/)).toBeVisible();

    // 改变筛选条件后清空选择。
    await page.getByRole('searchbox').first().fill('active');
    await expect(page.getByText(/已选 0 项/)).toBeVisible({ timeout: 10_000 });
  });

  test('移除监控前展示准确数量与完整名单', async ({ page }) => {
    await login(page);
    await visibleButton(page, '批量选择').click();
    await page.getByRole('checkbox').first().check();

    const dialog = await openRemoveDialog(page);
    // 确认框必须给出准确数量与完整仓库名，而不是模糊的“删除所选”。
    await expect(dialog.getByText('sample/active-project').first()).toBeVisible();
    await expect(page.getByText('删除所选')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('卡片与列表视图展示相同的核心字段与操作', async ({ page }) => {
    await login(page);
    const before = await page.getByRole('button', { name: /更多操作/ }).count();
    expect(before).toBeGreaterThan(0);
    await visibleButton(page, '紧凑列表视图').click();
    const after = await page.getByRole('button', { name: /更多操作/ }).count();
    expect(after).toBeGreaterThan(0);
  });
});

test.describe('Token 门禁', () => {
  test('登录后未验证 PAT 时添加仓库被服务端拒绝并给出修复指引', async ({ page }) => {
    await login(page);
    await visibleButton(page, '添加仓库').click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').first().fill('sample/new-repo');
    await dialog.getByRole('button', { name: /添加|提交|导入/ }).first().click();

    // 服务端返回 409 GITHUB_SETUP_REQUIRED；界面必须把管理员引到初始化步骤。
    await expect(page.getByText(/Token|PAT|初始化/).first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
  });

  test('设置页展示 Token 状态卡且不回显任何凭证片段', async ({ page }) => {
    await login(page);
    await page.goto('/settings');

    await expect(page.getByText(/GitHub Token|Token 状态/).first()).toBeVisible({ timeout: 15_000 });
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('ghp_');
    expect(body).not.toContain('github_pat_');
    // 未配置时不得宣称永久有效。
    expect(body).not.toContain('永久有效');
  });

  test('任务页可打开并展示调度与配额面板', async ({ page }) => {
    await login(page);
    await page.goto('/jobs');
    await expect(page.getByText(/任务|队列/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/配额|限流|退避/).first()).toBeVisible();
  });
});

test.describe('设置页交互与校验', () => {
  test('敏感输入带显示开关、档位为分段单选、操作按钮在章节右上', async ({ page }) => {
    await login(page);
    await page.goto('/settings');

    // 敏感输入统一提供显示/隐藏切换（Token 与修改密码三处；代理密码同组件）。
    for (const name of ['显示Token', '显示当前密码', '显示新密码', '显示确认新密码']) {
      await expect(page.getByRole('button', { name })).toBeVisible({ timeout: 15_000 });
    }

    // 默认检测档位是分段单选而不是下拉框（宽屏下不再左密右疏）。
    await expect(page.getByRole('radio')).toHaveCount(4);
    await expect(page.getByRole('radio', { name: '24 小时' })).toHaveAttribute('data-state', 'checked');

    // 操作按钮收在章节右上，用可访问名称暴露同一动作。
    for (const name of ['保存代理配置', '测试代理连通性', '重新验证当前 Token', '保存全局设置', '保存新密码']) {
      await expect(page.getByRole('button', { name })).toBeVisible();
    }

    // 任务页的清空历史同样是图标按钮；门禁未就绪时禁用（写操作由服务端拒绝）。
    await page.goto('/jobs');
    await expect(page.getByRole('button', { name: '清空历史' })).toBeDisabled();
  });

  test('输入校验即时可见且不顶开相邻字段', async ({ page }) => {
    await login(page);
    await page.goto('/settings');

    const portField = page.locator('#proxy-port');
    await expect(portField).toBeVisible({ timeout: 15_000 });
    const before = await portField.boundingBox();

    await page.getByLabel('主机').fill('bad host');
    await page.getByRole('button', { name: '保存代理配置' }).click();
    await expect(page.getByText(/必须是 IPv4/)).toBeVisible();

    // 错误提示占用预留高度槽：相邻字段的位置不因错误出现而移动。
    const after = await portField.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);

    // Token 输入按服务端同一规则即时拒绝非法前缀，不发请求。
    await page.getByLabel('Personal Access Token').fill('not-a-token');
    await page.getByRole('button', { name: '保存并验证 Token' }).click();
    await expect(page.getByText(/只接受 ghp_ 或 github_pat_/)).toBeVisible();
  });

  test('批量添加仓库在输入阶段就给出超限结论', async ({ page }) => {
    await login(page);
    const openImport = page.getByRole('button', { name: '添加仓库' }).first();
    await openImport.click();
    const textarea = page.getByLabel('仓库列表');
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    // 未超限：提示已输入行数，可以提交。
    await textarea.fill('owner/one\nowner/two');
    await expect(page.getByText('已输入 2 行')).toBeVisible();
    await expect(page.getByRole('button', { name: '开始导入' })).toBeEnabled();

    // 超过 999 行：粘贴后立刻给结论并禁用提交，而不是等点了提交才被拒。
    await textarea.fill(Array.from({ length: 1000 }, (_, index) => `owner/repo-${String(index)}`).join('\n'));
    await expect(page.getByText(/一次最多 999 行（当前 1000 行）/)).toBeVisible();
    await expect(page.getByRole('button', { name: '开始导入' })).toBeDisabled();
  });
});

test.describe('可访问性与视口', () => {
  test('切换趋势区间只发一次列表请求，且不产生每卡片请求', async ({ page }) => {
    const listRequests: string[] = [];
    const perCardRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (/\/api\/v1\/public\/repositories\/[^?]/.test(url)) perCardRequests.push(url);
      else if (url.includes('/api/v1/public/repositories')) listRequests.push(url);
    });

    await page.goto('/');
    await expect(page.getByText('sample/active-project').first()).toBeVisible();
    const before = listRequests.length;

    await page.getByRole('combobox', { name: '趋势区间' }).click();
    await page.getByRole('option', { name: '7 天' }).click();

    // 区间随列表请求一起下发给服务端：一次列表请求，且没有任何按卡片的趋势请求（禁止 N+1）。
    await expect.poll(() => listRequests.length).toBeGreaterThan(before);
    expect(listRequests.at(-1) ?? '').toContain('days=7');
    expect(perCardRequests).toHaveLength(0);
  });

  test('键盘可完成登录入口与主题切换', async ({ page }) => {
    await page.goto('/');
    // 等应用挂载再按 Tab：SPA 挂载前 body 为空，Tab 会落到浏览器 UI 上，
    // 高负载下偶发挂载延迟会让“跳到主要内容”断言悬空（本用例历史上两次全量抖动的根因）。
    const theme = page.getByRole('button', { name: /主题/ }).filter({ visible: true }).first();
    await theme.waitFor();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();

    await theme.click();
    await expect(page.getByRole('menuitem', { name: '深色' })).toBeVisible();
    await page.getByRole('menuitem', { name: '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
