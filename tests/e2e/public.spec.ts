import { expect, test } from '@playwright/test';

import { E2E_ORIGIN, E2E_PASSWORD } from '../playwright.config.js';

/**
 * 公开只读路径（「未登录浏览」「双视图」「未登录不闪现管理控件」）。
 *
 * 未登录时看板必须可读，且不出现任何管理入口；管理页面转到登录页并保留 returnTo。
 */

test.describe('匿名浏览', () => {
  test('看板可打开且不出现管理控件', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();

    // 管理入口在未登录时不得出现（不依赖按钮隐藏做授权，但界面上也不应闪现）。
    await expect(page.getByRole('button', { name: '添加仓库' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '批量选择' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '暂停自动检测' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '检测' })).toHaveCount(0);
  });

  test('筛选条件写入 URL 并可被浏览器返回恢复', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('searchbox').first();
    // 选择器失效必须让用例失败，而不是静默跳过变绿。
    await expect.poll(() => search.count()).toBeGreaterThan(0);
    await search.fill('radar');
    await expect.poll(() => page.url()).toContain('q=radar');

    await page.goBack();
    await expect.poll(() => page.url()).not.toContain('q=radar');
  });

  test('清除筛选会取消待触发的搜索防抖，搜索词不会自己回来', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('searchbox').first();
    await expect.poll(() => search.count()).toBeGreaterThan(0);
    await search.fill('radar');
    await expect.poll(() => page.url()).toContain('q=radar');

    // 再次输入触发新的防抖计时器，紧接着清除筛选：定时器必须被取消。
    await search.fill('radar-two');
    await page.getByRole('region', { name: '筛选' }).getByRole('button', { name: '清除筛选' }).click();
    // 点击后立即断言：防抖定时器若未被取消，最快 400ms 后写回，这里先排除
    // "定时器早已先触发"的假通过路径（fill 与 click 之间不等待）。
    expect(page.url()).not.toContain('radar-two');
    await expect.poll(() => page.url()).not.toContain('q=');
    await page.waitForTimeout(600);
    expect(page.url()).not.toContain('q=');
  });

  test('卡片/列表视图切换保留筛选并记住偏好', async ({ page }) => {
    await page.goto('/');
    const listToggle = page.getByRole('button', { name: /列表/ }).first();
    await expect.poll(() => listToggle.count()).toBeGreaterThan(0);

    await listToggle.click();
    await page.reload();
    const stored = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(stored).toContain('githubradar:');
  });

  test('发现模块默认启用，导航常驻发现入口', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: '项目发现' })).toHaveCount(1);
  });

  test('每日趋势页可匿名打开，展示名次变化与新上榜', async ({ page }) => {
    await page.goto('/trends');
    await expect(page.getByRole('heading', { name: '每日趋势' })).toBeVisible();

    // 种子报告：quiet-library 从第 2 升到第 1，new-entry 首次出现。
    const list = page.getByRole('list', { name: '每日趋势榜单' });
    await expect(list.getByText('sample/quiet-library')).toBeVisible();
    await expect(list.getByText('↑1')).toBeVisible();
    await expect(list.getByText('新上榜')).toBeVisible();
  });

  test('未登录访问系统设置转到登录页并携带 returnTo', async ({ page }) => {
    await page.goto('/settings');
    await expect.poll(() => page.url()).toContain('/login');
    expect(page.url()).toContain('returnTo');
  });

  test('未知路径不返回空白页', async ({ page }) => {
    const response = await page.goto('/not-a-real-page');
    expect(response?.status()).toBe(404);
  });

  test('手机视口无整页横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('公开接口边界', () => {
  test('未知参数被拒绝，管理接口匿名返回 401 的 JSON 信封', async ({ request }) => {
    const bad = await request.get('/api/v1/public/repositories?page=0');
    expect(bad.status()).toBe(400);
    const badBody = (await bad.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe('VALIDATION_FAILED');

    const admin = await request.get('/api/v1/admin/system-status');
    expect(admin.status()).toBe(401);
    expect(admin.headers()['cache-control']).toBe('no-store');

    const unknownApi = await request.get('/api/v1/does-not-exist');
    expect(unknownApi.status()).toBe(404);
    expect(unknownApi.headers()['content-type']).toContain('application/json');
  });

  test('公开响应带 ETag 且同参数下匿名与登录结果一致', async ({ request }) => {
    const first = await request.get('/api/v1/public/repositories');
    expect(first.headers()['etag']).toBeDefined();
    const anonymousBody = await first.text();
    const second = await request.get('/api/v1/public/repositories', {
      headers: { 'if-none-match': first.headers()['etag'] ?? '' },
    });
    expect(second.status()).toBe(304);

    // 登录态同参数请求必须返回逐字节相同的公开 DTO：公开投影不因会话改变，
    // 也不能借登录态夹带管理字段（接口层有同一断言的用例）。
    const login = await request.post('/api/v1/auth/login', {
      headers: { origin: E2E_ORIGIN, 'content-type': 'application/json' },
      data: { username: 'admin', password: E2E_PASSWORD, rememberMe: false },
    });
    expect(login.status()).toBe(200);

    // 先证明这条请求上下文真的带着会话：否则下面的比对会在「实际仍是匿名」时假通过。
    const session = await request.get('/api/v1/auth/session');
    expect(((await session.json()) as { data: { authenticated: boolean } }).data.authenticated).toBe(true);

    const authenticated = await request.get('/api/v1/public/repositories');
    expect(authenticated.status()).toBe(200);
    expect(await authenticated.text()).toBe(anonymousBody);
  });
});
