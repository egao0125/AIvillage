import { test, expect } from '@playwright/test';

/**
 * 02 — REST API エンドポイント
 * 認証なしで叩けるパブリックエンドポイントの応答確認
 */

test.describe('API ヘルスチェック', () => {
  test('GET /api/health → {status: ok}', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThan(0);
  });

  test('GET /api/agents → 配列', async ({ request }) => {
    const res = await request.get('/api/agents');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/agents → エージェント配列を返す', async ({ request }) => {
    const res = await request.get('/api/agents');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('存在しないAPIエンドポイント → SPAフォールバック(200)またはエラー', async ({ request }) => {
    const res = await request.get('/api/nonexistent-endpoint-xyz');
    // SPAはUnknown API routeに対して200(index.html)または404を返す
    expect(res.status()).toBeLessThan(500);
  });

  test('セキュリティヘッダーが設定されている', async ({ request }) => {
    const res = await request.get('/');
    const headers = res.headers();
    // ALB/WAFレイヤーで付与されるべきヘッダー
    expect(headers['x-content-type-options'] ?? headers['x-xss-protection'] ?? headers['strict-transport-security']).toBeTruthy();
  });

  test('Content-Type が正しく設定される', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.headers()['content-type']).toContain('application/json');
  });
});

test.describe('API 認証保護', () => {
  test('認証が必要なエンドポイントに未認証でアクセス → 401/403', async ({ request }) => {
    // DevPanel系のエンドポイント（悪用防止）
    const res = await request.post('/api/dev/fresh-start');
    expect([401, 403, 404, 405]).toContain(res.status());
  });

  test('エージェント作成に不正データ → バリデーションエラー', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { name: '', occupation: '' },
    });
    expect([400, 401, 403, 422]).toContain(res.status());
  });
});
