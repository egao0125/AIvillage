import { Page } from '@playwright/test';

/** Socket.IO接続が確立されるまで待機 */
export async function waitForSocketConnected(page: Page, timeout = 15_000): Promise<boolean> {
  return page.evaluate((ms) => {
    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + ms;
      const check = () => {
        // GameStore経由でconnected状態を確認
        const el = document.querySelector('[data-testid="connection-status"]');
        if (el?.textContent?.toLowerCase().includes('connected')) {
          return resolve(true);
        }
        if (Date.now() > deadline) return resolve(false);
        setTimeout(check, 300);
      };
      check();
    });
  }, timeout);
}

/** Socket.IOが特定のイベントを受信するまで待機 */
export async function waitForSocketEvent(page: Page, eventName: string, timeout = 10_000): Promise<unknown> {
  return page.evaluate(
    ({ event, ms }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), ms);
        // window.__socket はsocket.tsでglobal exposedされている想定
        const socket = (window as unknown as Record<string, unknown>).__socket as {
          once: (e: string, cb: (d: unknown) => void) => void;
        } | undefined;
        if (!socket) return reject(new Error('Socket not found on window'));
        socket.once(event, (data) => {
          clearTimeout(timer);
          resolve(data);
        });
      });
    },
    { event: eventName, ms: timeout }
  );
}
