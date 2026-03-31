import { test, expect, request as playwrightRequest } from '@playwright/test';

/**
 * 05 — エージェントライフサイクル（作成→確認→削除）
 * 本番データ汚染を防ぐため、テスト終了時に必ずクリーンアップする
 */

const TEST_AGENT = {
  name: 'E2E_Test_Agent_DELETE_ME',
  occupation: 'Tester',
  personality: { openness: 5, conscientiousness: 5, extraversion: 5, agreeableness: 5, neuroticism: 5 },
  fears: ['being ignored'],
  desires: ['passing tests'],
  values: ['accuracy'],
  contradictions: ['tests both create and destroy'],
  apiKey: '',   // BYOKなし → LLM呼び出しスキップ
  model: 'claude-haiku-4-5-20251001',
};

let createdAgentId: string | null = null;

test.describe('エージェント作成・削除（APIレベル）', () => {
  test.afterAll(async () => {
    // クリーンアップ: テストエージェントを必ず削除
    if (createdAgentId) {
      const ctx = await playwrightRequest.newContext({ baseURL: 'https://ai-village.net' });
      await ctx.delete(`/api/agents/${createdAgentId}`).catch(() => {});
      await ctx.dispose();
    }
  });

  test('POST /api/agents → エージェント作成', async ({ request }) => {
    const res = await request.post('/api/agents', { data: TEST_AGENT });
    // 認証が必要な場合は401/403 (それも正常な動作)
    if (res.status() === 401 || res.status() === 403) {
      test.skip();
      return;
    }
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    expect(body.id ?? body.agentId).toBeTruthy();
    createdAgentId = body.id ?? body.agentId;
  });

  test('GET /api/agents → 作成したエージェントが含まれる', async ({ request }) => {
    if (!createdAgentId) test.skip();
    const res = await request.get('/api/agents');
    expect(res.status()).toBe(200);
    const agents: { id: string; name: string }[] = await res.json();
    const found = agents.find((a) => a.id === createdAgentId);
    expect(found).toBeTruthy();
    expect(found?.name).toBe(TEST_AGENT.name);
  });

  test('GET /api/agents/:id → 個別エージェント取得', async ({ request }) => {
    if (!createdAgentId) test.skip();
    const res = await request.get(`/api/agents/${createdAgentId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(TEST_AGENT.name);
  });

  test('POST /api/agents/:id/suspend → 離村', async ({ request }) => {
    if (!createdAgentId) test.skip();
    const res = await request.post(`/api/agents/${createdAgentId}/suspend`);
    expect([200, 204]).toContain(res.status());
  });

  test('POST /api/agents/:id/resume → 復帰', async ({ request }) => {
    if (!createdAgentId) test.skip();
    const res = await request.post(`/api/agents/${createdAgentId}/resume`);
    expect([200, 204]).toContain(res.status());
  });

  test('DELETE /api/agents/:id → エージェント削除', async ({ request }) => {
    if (!createdAgentId) test.skip();
    const res = await request.delete(`/api/agents/${createdAgentId}`);
    expect([200, 204]).toContain(res.status());
    createdAgentId = null; // afterAll でのダブル削除を防ぐ
  });
});

test.describe('UIでのエージェント作成フロー', () => {
  test('SetupPageでエージェント名を入力できる', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('button:has-text("SIGN UP"), canvas', { timeout: 15_000 });
    await page.waitForTimeout(1_000);

    // SetupPageには直接NAMEフィールドが存在する
    const nameInput = page.locator('input[placeholder*="Yuki"], input[placeholder*="name" i]').first();
    if (await nameInput.isVisible()) {
      await nameInput.fill('TestName入力確認');
      expect(await nameInput.inputValue()).toBe('TestName入力確認');
      await nameInput.clear();
      return;
    }

    const addBtn = page.locator('button:has-text("ADD"), button:has-text("Add"), text=/add agent/i').first();
    if (!await addBtn.isVisible()) {
      test.skip();
      return;
    }

    await addBtn.click();
    await page.waitForTimeout(500);

    const addFormInput = page.locator('input[placeholder*="name" i], input[placeholder*="Name"]').first();
    if (await addFormInput.isVisible()) {
      await addFormInput.fill('Test入力確認');
      expect(await addFormInput.inputValue()).toBe('Test入力確認');
      await addFormInput.clear();
    }
  });
});
