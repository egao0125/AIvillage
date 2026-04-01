import { test, expect, request as playwrightRequest } from '@playwright/test';

/**
 * 05 — エージェントライフサイクル
 * 認証が必要なエンドポイントは401を確認（正しいセキュリティ動作）。
 * 読み取り系（GET）は認証不要。
 * 本番データ汚染を防ぐためエージェント作成テストは認証ありのみ実行。
 */

test.describe('エージェント読み取り（認証不要）', () => {
  test('GET /api/agents → 2エージェント存在する', async ({ request }) => {
    const res = await request.get('/api/agents');
    expect(res.status()).toBe(200);
    const agents: unknown[] = await res.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });

  test('GET /api/world → simulationが動作している', async ({ request }) => {
    const res = await request.get('/api/world');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.agents?.length).toBeGreaterThanOrEqual(2);
    expect(typeof body.time?.day).toBe('number');
    expect(body.time.day).toBeGreaterThan(0);
  });

  test('GET /api/config/status → running: true', async ({ request }) => {
    const res = await request.get('/api/config/status');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.running).toBe(true);
    expect(body.agentCount).toBeGreaterThanOrEqual(2);
  });

  test('GET /api/agents/:id/timeline → タイムラインが取得できる', async ({ request }) => {
    const agentsRes = await request.get('/api/agents');
    const agents: { id: string }[] = await agentsRes.json();
    expect(agents.length).toBeGreaterThan(0);

    const res = await request.get(`/api/agents/${agents[0].id}/timeline`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/ready → ready', async ({ request }) => {
    const res = await request.get('/api/ready');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
  });
});

test.describe('認証保護の確認（未認証 → 401）', () => {
  test('POST /api/agents → 401 Sign in required', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { name: 'TestAgent', occupation: 'Tester' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('DELETE /api/agents/:id → 401', async ({ request }) => {
    const agentsRes = await request.get('/api/agents');
    const agents: { id: string }[] = await agentsRes.json();
    const res = await request.delete(`/api/agents/${agents[0].id}`);
    expect(res.status()).toBe(401);
  });

  test('POST /api/agents/:id/suspend → 401', async ({ request }) => {
    const agentsRes = await request.get('/api/agents');
    const agents: { id: string }[] = await agentsRes.json();
    const res = await request.post(`/api/agents/${agents[0].id}/suspend`);
    expect(res.status()).toBe(401);
  });

  test('POST /api/agents/:id/resume → 401', async ({ request }) => {
    const agentsRes = await request.get('/api/agents');
    const agents: { id: string }[] = await agentsRes.json();
    const res = await request.post(`/api/agents/${agents[0].id}/resume`);
    expect(res.status()).toBe(401);
  });

  test('POST /api/admin/resurrect-all → 401または403（管理者専用）', async ({ request }) => {
    const res = await request.post('/api/admin/resurrect-all');
    expect([401, 403]).toContain(res.status());
  });
});

test.describe('UIでのエージェント作成フロー', () => {
  test('SetupPageでエージェント名を入力できる', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('button:has-text("SIGN UP"), canvas', { timeout: 15_000 });
    await page.waitForTimeout(1_000);

    const nameInput = page.locator('input[placeholder*="Yuki"], input[placeholder*="name" i]').first();
    if (await nameInput.isVisible()) {
      await nameInput.fill('TestName入力確認');
      expect(await nameInput.inputValue()).toBe('TestName入力確認');
      await nameInput.clear();
      return;
    }

    const addBtn = page.locator('button:has-text("ADD"), button:has-text("Add"), text=/add agent/i').first();
    if (!await addBtn.isVisible()) { test.skip(); return; }

    await addBtn.click();
    await page.waitForTimeout(500);

    const addFormInput = page.locator('input[placeholder*="name" i], input[placeholder*="Name"]').first();
    if (await addFormInput.isVisible()) {
      await addFormInput.fill('Test入力確認');
      expect(await addFormInput.inputValue()).toBe('Test入力確認');
      await addFormInput.clear();
    }
  });

  test('エージェント一覧がUIに表示される', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('button:has-text("SIGN UP"), canvas', { timeout: 15_000 });
    await page.waitForTimeout(2_000);

    // man / woman エージェントが表示されていること
    const manEl = page.locator('text=man').first();
    const womanEl = page.locator('text=woman').first();
    const hasAgents = (await manEl.count()) > 0 || (await womanEl.count()) > 0;
    expect(hasAgents, 'エージェント名がUIに表示されていない').toBe(true);
  });
});
