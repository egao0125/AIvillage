import { test, expect } from '@playwright/test';

/**
 * 01 — ページロード・基本レンダリング
 * TLS / HTTP→HTTPS / 初期表示 / アセット
 */

test.describe('ページロード', () => {
  test('HTTPS 200 で応答する', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    expect(page.url()).toMatch(/^https:\/\//);
  });

  test('HTTP → HTTPS リダイレクト', async ({ page }) => {
    const response = await page.goto('http://ai-village.net/');
    // ALBがリダイレクト後に最終的にHTTPSになっていること
    expect(page.url()).toMatch(/^https:\/\//);
    expect(response?.status()).toBeLessThan(400);
  });

  test('タイトルが設定されている', async ({ page }) => {
    await page.goto('/');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test('Phaserキャンバスまたはセットアップ画面が表示される', async ({ page }) => {
    await page.goto('/');
    // ログイン前はSetupPage、ログイン後はPhaserキャンバスが表示される
    const content = page.locator('canvas, [class*="setup"], button:has-text("SIGN UP"), button:has-text("LOG IN")').first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test('Reactルートがマウントされる', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#root', { timeout: 10_000 });
    // React DOMが何らかの子要素をレンダリングしていること
    const childCount = await page.locator('#root').evaluate((el) => el.childElementCount);
    expect(childCount).toBeGreaterThan(0);
  });

  test('致命的なJavaScriptエラーがコンソールに出ない', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForTimeout(5_000);
    const fatal = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('punycode') &&
        !e.includes('DeprecationWarning')
    );
    expect(fatal, `JSクラッシュエラー: ${fatal.join('\n')}`).toHaveLength(0);
  });

  test('静的アセットが404を返さない（CSS/JS）', async ({ page }) => {
    const failed: string[] = [];
    page.on('response', (res) => {
      if (res.status() === 404 && /\.(js|css|woff2?)$/.test(res.url())) {
        failed.push(res.url());
      }
    });
    await page.goto('/');
    await page.waitForTimeout(5_000);
    expect(failed, `404アセット: ${failed.join('\n')}`).toHaveLength(0);
  });

  test('モバイルビューでアプリが表示される', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    // ログイン前はSetupPage、ログイン後はキャンバスが表示
    const content = page.locator('canvas, button:has-text("SIGN UP"), button:has-text("LOG IN"), [class*="setup"]').first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });
});
