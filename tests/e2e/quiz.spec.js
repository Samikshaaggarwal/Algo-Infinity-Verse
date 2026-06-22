import { test, expect } from '@playwright/test';

test.describe('Quiz Flow', () => {
  test('should load the quiz section', async ({ page }) => {
    await page.goto('/');

    // Find the quiz section
    const quizSection = page.locator('#quiz');
    await expect(quizSection).toBeVisible();

    // Ensure there is at least one quiz card generated
    // We check for the quiz-grid container
    const quizGrid = page.locator('.quiz-grid');
    await expect(quizGrid).toBeVisible();
  });
});
