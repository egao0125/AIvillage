import { test, expect } from '@playwright/test';

const READY_SELECTOR = 'button:has-text("SIGN UP"), canvas';

/**
 * 07 — パフォーマンス・安定性
 */

test.describe('ロードパフォーマンス', () => {
  test('初期ロードが10秒以内に完了する', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    await page.waitForSelector(READY_SELECTOR, { timeout: 15_000 });
    const elapsed = Date.now() - start;
    expect(elapsed, `ロードに${elapsed}ms かかった（上限10000ms）`).toBeLessThan(10_000);
  });

  test('LCP (Largest Contentful Paint) が4秒以内', async ({ page }) => {
    await page.goto('/');
    const lcp = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          resolve((last as PerformanceEntry & { startTime: number }).startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => resolve(-1), 8000);
      });
    });
    if (lcp > 0) {
      expect(lcp, `LCP ${lcp}ms — 上限4000ms`).toBeLessThan(4_000);
    }
  });

  test('ページが30秒間クラッシュしない', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForSelector(READY_SELECTOR, { timeout: 15_000 });
    await page.waitForTimeout(30_000);

    const fatal = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('punycode')
    );
    expect(fatal, `30秒間で発生したエラー:\n${fatal.join('\n')}`).toHaveLength(0);
  });

  test('メモリ使用量が過度に増加しない', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector(READY_SELECTOR, { timeout: 15_000 });

    const memBefore = await page.evaluate(() =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
    );

    await page.waitForTimeout(15_000);

    const memAfter = await page.evaluate(() =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
    );

    if (memBefore > 0 && memAfter > 0) {
      const growthMB = (memAfter - memBefore) / 1024 / 1024;
      expect(growthMB, `メモリが${growthMB.toFixed(1)}MB増加（上限100MB）`).toBeLessThan(100);
    }
  });
});

test.describe('モバイル・レスポンシブ', () => {
  test('iPhone 14サイズでアプリが表示される', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.waitForSelector(READY_SELECTOR, { timeout: 15_000 });
    await expect(page.locator(READY_SELECTOR).first()).toBeVisible();
  });

  test('タブレットサイズでレイアウトが崩れない', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    await page.waitForSelector(READY_SELECTOR, { timeout: 15_000 });
    await expect(page.locator(READY_SELECTOR).first()).toBeVisible();
    // 水平スクロールバーが出ていないこと（5pxの許容誤差）
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
  });
});
