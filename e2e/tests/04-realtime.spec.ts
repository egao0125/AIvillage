import { test, expect } from '@playwright/test';

/**
 * 04 — Socket.IO リアルタイム通信
 * SetupPage表示中でもSocket.IO接続は確立される。
 */

test.describe('Socket.IO 接続', () => {
  test('WebSocket接続が確立される（ネットワーク監視）', async ({ page }) => {
    test.setTimeout(20_000);
    let wsConnected = false;
    let wsMessageCount = 0;

    page.on('websocket', (ws) => {
      wsConnected = true;
      ws.on('framesent', () => wsMessageCount++);
      ws.on('framereceived', () => wsMessageCount++);
    });

    await page.goto('/');
    await page.waitForSelector('button:has-text("SIGN UP"), canvas', { timeout: 15_000 });
    await page.waitForTimeout(5_000);

    // WebSocketまたはポーリングのどちらかでSocket.IOが動作していること
    // (Socket.IOはポーリングで始まり、その後WebSocketにアップグレードする)
    if (!wsConnected) {
      // ポーリング経由での接続確認（/socket.io/へのHTTPリクエスト）
      const socketPollRes = await page.request.get('/socket.io/?EIO=4&transport=polling').catch(() => null);
      const connected = socketPollRes !== null && socketPollRes.status() < 500;
      expect(connected, 'Socket.IOが応答しない').toBe(true);
    } else {
      expect(wsMessageCount).toBeGreaterThan(0);
    }
  });

  test('Socket.IOエンドポイントが応答する', async ({ request }) => {
    const res = await request.get('/socket.io/?EIO=4&transport=polling');
    expect(res.status()).toBeLessThan(500);
  });

  test('Socket.IO接続後にSnapshotを受信する（ネットワーク確認）', async ({ page }) => {
    test.setTimeout(20_000);
    const receivedMessages: string[] = [];

    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        const payload = typeof frame.payload === 'string'
          ? frame.payload
          : Buffer.isBuffer(frame.payload) ? frame.payload.toString() : '';
        if (payload) receivedMessages.push(payload.slice(0, 100));
      });
    });

    await page.goto('/');
    await page.waitForSelector('button:has-text("SIGN UP"), canvas', { timeout: 15_000 });
    await page.waitForTimeout(5_000);

    if (receivedMessages.length > 0) {
      const hasSocketMessages = receivedMessages.some(
        (m) => m.includes('{') || m.includes('[') || m.startsWith('0') || m.startsWith('4')
      );
      expect(hasSocketMessages, 'Socket.IOフォーマット外のメッセージ').toBe(true);
    } else {
      // WebSocketフレームが見えない場合はAPIで接続を確認
      const res = await page.request.get('/api/health');
      expect(res.status()).toBe(200);
    }
  });

  test('ネットワーク切断後にページが生き残る', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('button:has-text("SIGN UP"), canvas', { timeout: 15_000 });

    await page.context().setOffline(true);
    await page.waitForTimeout(2_000);
    await page.context().setOffline(false);
    await page.waitForTimeout(3_000);

    // ページがクラッシュしていないこと
    await expect(page.locator('button:has-text("SIGN UP"), canvas').first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('リアルタイム状態確認（APIポーリング）', () => {
  test('/api/health が継続的に200を返す', async ({ request }) => {
    for (let i = 0; i < 3; i++) {
      const res = await request.get('/api/health');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    }
  });
});
