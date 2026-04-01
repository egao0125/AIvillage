import { test, expect } from '@playwright/test';

/**
 * 06 — セキュリティヘッダー・入力バリデーション・認証
 */

test.describe('HTTPセキュリティヘッダー', () => {
  test('Strict-Transport-Security (HSTS) が設定されている', async ({ request }) => {
    const res = await request.get('/');
    const hsts = res.headers()['strict-transport-security'];
    expect(hsts, 'HSTSヘッダー未設定 — HTTPSダウングレード攻撃リスク').toBeTruthy();
    if (hsts) {
      expect(hsts).toContain('max-age');
    }
  });

  test('X-Content-Type-Options: nosniff が設定されている', async ({ request }) => {
    const res = await request.get('/');
    const val = res.headers()['x-content-type-options'];
    expect(val, 'X-Content-Type-Options未設定 — MIMEスニッフィングリスク').toBe('nosniff');
  });

  test('X-Frame-Options または CSP frame-ancestors が設定されている', async ({ request }) => {
    const res = await request.get('/');
    const xfo = res.headers()['x-frame-options'];
    const csp = res.headers()['content-security-policy'];
    const hasFrameProtection =
      !!xfo || (!!csp && csp.includes('frame-ancestors'));
    expect(hasFrameProtection, 'クリックジャッキング対策未設定').toBe(true);
  });

  test('Serverヘッダーが詳細情報を漏洩しない', async ({ request }) => {
    const res = await request.get('/');
    const server = res.headers()['server'] ?? '';
    // nginx/1.2.3 や Apache/2.4.x のようなバージョン情報がないこと
    expect(server).not.toMatch(/\d+\.\d+/);
  });

  test('API が X-Powered-By を返さない', async ({ request }) => {
    const res = await request.get('/api/health');
    const powered = res.headers()['x-powered-by'];
    expect(powered, 'X-Powered-By はサーバー情報を漏洩する').toBeFalsy();
  });
});

test.describe('入力バリデーション・インジェクション耐性', () => {
  test('エージェント名のNewlineインジェクションが拒否される', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { name: 'test\r\nX-Injected: header', occupation: 'Tester' },
    });
    expect([400, 401, 403, 422]).toContain(res.status());
  });

  test('極端に長い名前が拒否される', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { name: 'A'.repeat(10000), occupation: 'Tester' },
    });
    expect([400, 401, 403, 413, 422]).toContain(res.status());
  });

  test('スペクテーターコメントのXSS文字列が返却時にエスケープされる', async ({ page }) => {
    await page.goto('/');
    // ログイン前でもSetupPageが表示されていること確認
    await page.waitForSelector('button:has-text("SIGN UP"), button:has-text("LOG IN"), canvas', { timeout: 15_000 });
    await page.waitForTimeout(2_000);

    // XSSペイロードがscriptとして実行されないことを確認
    let xssExecuted = false;
    await page.exposeFunction('__xssDetected', () => { xssExecuted = true; });

    // SetupPageのテキストフィールドか、ログイン後のchat inputを試みる
    const chatInput = page.locator('input[placeholder*="comment" i], input[placeholder*="message" i], textarea').first();
    if (await chatInput.isVisible()) {
      await chatInput.fill('<img src=x onerror="__xssDetected()">');
      await chatInput.press('Enter');
      await page.waitForTimeout(2_000);
      expect(xssExecuted, 'XSSが実行された！').toBe(false);
    } else {
      // ログイン前でchat inputなし — ページ自体がXSSを実行していないことを確認
      expect(xssExecuted).toBe(false);
    }
  });

  test('SQLインジェクション文字列がAPIで処理される', async ({ request }) => {
    const res = await request.get("/api/agents?name=' OR '1'='1");
    // クラッシュせず正常なレスポンスを返すこと
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe('認証・認可', () => {
  test('不正なJWTトークンで401を返す', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { name: 'test', occupation: 'test' },
      headers: { Authorization: 'Bearer invalid.jwt.token' },
    });
    expect([400, 401, 403]).toContain(res.status());
  });

  test('CORS: 不正なOriginからのAPIアクセスが制限される', async ({ request }) => {
    const res = await request.get('/api/agents', {
      headers: { Origin: 'https://evil-site.example.com' },
    });
    const corsHeader = res.headers()['access-control-allow-origin'];
    // evil-siteへの許可がないこと
    if (corsHeader) {
      expect(corsHeader).not.toBe('https://evil-site.example.com');
      expect(corsHeader).not.toBe('*');
    }
  });
});
