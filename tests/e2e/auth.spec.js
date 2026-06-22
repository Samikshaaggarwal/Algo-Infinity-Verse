import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {
  test('should load main page and verify hero content', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Check page title
    await expect(page).toHaveTitle(/Algo Infinity Verse/);
    
    // Check if the navbar placeholder is visible
    await expect(page.locator('#navbar-placeholder')).toBeVisible();

    // Check if hero section is visible
    await expect(page.locator('.hero-content')).toBeVisible();
  });
});
