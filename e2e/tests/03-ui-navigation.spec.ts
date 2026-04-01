import { test, expect } from '@playwright/test';

/**
 * 03 — UI ナビゲーション・コンポーネント表示
 * 注意: 未ログイン状態ではSetupPage（ログイン+エージェント作成画面）が表示される。
 * canvas（ゲーム画面）はエージェント作成後/ログイン後に表示される。
 */

const READY_SELECTOR = 'button:has-text("SIGN UP"), button:has-text("LOG IN"), canvas, button:has-text("CREATE")';

test.describe('SetupPage（初期画面）表示', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector(READY_SELECTOR, { timeout: 15_000 });
    await page.waitForTimeout(1_000);
  });

  test('AI VILLAGE タイトルが表示される', async ({ page }) => {
    const title = page.locator('text=AI VILLAGE').first();
    await expect(title).toBeVisible({ timeout: 5_000 });
  });

  test('サインアップ・ログインボタンが表示される', async ({ page }) => {
    await expect(page.locator('button:has-text("SIGN UP")').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button:has-text("LOG IN")').first()).toBeVisible({ timeout: 5_000 });
  });

  test('メールアドレスとパスワードフィールドが存在する', async ({ page }) => {
    await expect(page.locator('input[type="email"], input[placeholder*="email" i]').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('input[type="password"], input[placeholder*="password" i]').first()).toBeVisible({ timeout: 5_000 });
  });

  test('エージェント作成フォームが存在する', async ({ page }) => {
    // NAME / AGE フィールド
    await expect(page.locator('text=NAME').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=AGE').first()).toBeVisible({ timeout: 5_000 });
  });

  test('CREATE AGENTボタンが存在する', async ({ page }) => {
    const createBtn = page.locator('button:has-text("CREATE AGENT"), button:has-text("+ CREATE")').first();
    await expect(createBtn).toBeVisible({ timeout: 5_000 });
  });

  test('APIキー入力フィールドが存在する', async ({ page }) => {
    const apiKeyInput = page.locator('input[placeholder*="sk-ant"]').first();
    await expect(apiKeyInput).toBeVisible({ timeout: 5_000 });
  });

  test('モデル選択ドロップダウンが存在する', async ({ page }) => {
    const modelSelect = page.locator('select').first();
    await expect(modelSelect).toBeVisible({ timeout: 5_000 });
    const options = await modelSelect.locator('option').allTextContents();
    expect(options.some((o) => o.toLowerCase().includes('haiku'))).toBe(true);
  });

  test('PERSONALITY展開ボタンが動作する', async ({ page }) => {
    const personalityBtn = page.locator('button:has-text("PERSONALITY")').first();
    await expect(personalityBtn).toBeVisible({ timeout: 5_000 });
    await personalityBtn.click();
    await page.waitForTimeout(300);
    // クラッシュしないこと
    await expect(page.locator('button:has-text("SIGN UP")').first()).toBeVisible();
  });

  test('DEEP IDENTITY展開ボタンが動作する', async ({ page }) => {
    const identityBtn = page.locator('button:has-text("DEEP IDENTITY")').first();
    await expect(identityBtn).toBeVisible({ timeout: 5_000 });
    await identityBtn.click();
    await page.waitForTimeout(300);
    await expect(page.locator('button:has-text("SIGN UP")').first()).toBeVisible();
  });

  test('NAME入力フィールドにテキストを入力できる', async ({ page }) => {
    const nameInput = page.locator('input[placeholder*="Yuki"], input[placeholder*="name" i]').first();
    if (await nameInput.isVisible()) {
      await nameInput.fill('TestName');
      expect(await nameInput.inputValue()).toBe('TestName');
      await nameInput.clear();
    }
  });

  test('SOULテキストエリアに入力できる', async ({ page }) => {
    const soulArea = page.locator('textarea').first();
    if (await soulArea.isVisible()) {
      await soulArea.fill('Test soul description');
      expect(await soulArea.inputValue()).toContain('Test soul description');
      await soulArea.clear();
    }
  });
});

test.describe('Villagersサイドバーパネル', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector(READY_SELECTOR, { timeout: 15_000 });
    await page.waitForTimeout(1_000);
  });

  test('Villagersリストエリアが表示される', async ({ page }) => {
    const villagers = page.locator('text=Villagers').first();
    await expect(villagers).toBeVisible({ timeout: 5_000 });
  });
});
