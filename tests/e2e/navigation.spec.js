import { test, expect } from '@playwright/test';

test.describe('Navigation and Topics Flow', () => {
  test('should navigate to DSA Topics and view content', async ({ page }) => {
    await page.goto('/');

    // Ensure topics section is visible
    const topicsSection = page.locator('#topics');
    await expect(topicsSection).toBeVisible();

    // Ensure the practice section is visible
    const practiceSection = page.locator('#practice');
    await expect(practiceSection).toBeVisible();

    // Check if the filter buttons are rendered
    await expect(page.locator('.filter-btn[data-filter="all"]')).toBeVisible();
  });
});
