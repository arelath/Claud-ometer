import { test, expect } from './coverage.fixture';
import { fixtureSessionIds, toolPairFixtureSessionId } from '../shared/seed-imported-data';

test('sessions page supports search and navigation to session detail', async ({ page }) => {
  await page.goto('/sessions');

  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.locator(`a[href="/sessions/${fixtureSessionIds[0]}"]`)).toBeVisible();

  const search = page.getByPlaceholder('Search across all session messages...');
  await search.fill('Context Builder');

  await expect(page).toHaveURL(/\/sessions\?q=Context\+Builder|\/sessions\?q=Context%20Builder/);
  await expect(page.getByText(/sessions? matching "Context Builder"/i)).toBeVisible();

  const filteredResult = page.locator('a[href^="/sessions/"]').first();
  await expect(filteredResult).toBeVisible();
  await filteredResult.click();
  await expect(page).toHaveURL(/\/sessions\/.+/);
  await expect(page.getByText('Token usage')).toBeVisible();
  await page.getByRole('button', { name: 'Window' }).click();
  await expect(page.getByText('current prompt')).toBeVisible();
  await expect(page.getByText('Files', { exact: true })).toBeVisible();
  await expect(page.getByText('Tools', { exact: true })).toBeVisible();
  await expect(page.getByText('Files in context')).toBeVisible();
});

test('session detail renders multiline tool output and theme toggle persists', async ({ page }) => {
  await page.goto(`/sessions/${fixtureSessionIds[0]}`);

  await expect(page.getByRole('button', { name: /Narrative/i })).toBeVisible();
  const html = page.locator('html');
  const initialIsDark = ((await html.getAttribute('class')) || '').includes('dark');

  const themeToggle = page.getByRole('button', { name: /Light Mode|Dark Mode/i });
  await themeToggle.click();
  await expect.poll(async () => (((await html.getAttribute('class')) || '').includes('dark'))).toBe(!initialIsDark);

  await page.getByRole('button', { name: /\+ Tools/i }).click();

  const expandPreviewButton = page.getByRole('button', { name: 'Expand' }).first();
  await expect(expandPreviewButton).toBeVisible();
  await expandPreviewButton.click();
  await expect(page.locator('*:visible').filter({ hasText: 'Everything else is deferred until a real run demands it.' }).first()).toBeVisible();

  await page.goto('/data');
  await expect.poll(async () => (((await page.locator('html').getAttribute('class')) || '').includes('dark'))).toBe(!initialIsDark);
});

test('session context file panel copies all paths and maps loaded ranges to source lines', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:3005' });
  await page.goto(`/sessions/${toolPairFixtureSessionId}`);

  await page.getByRole('button', { name: 'Window' }).click();
  await expect(page.getByText('Files in context')).toBeVisible();

  const rangeBar = page.getByTestId('context-file-range-bar').filter({
    has: page.locator('[data-testid="context-file-range-segment"][data-range-start="110"][data-range-end="119"]'),
  });
  await expect(rangeBar).toHaveCount(1);
  await expect(rangeBar).toHaveAttribute('title', /L110-119/);

  const rangeSegment = rangeBar.locator('[data-testid="context-file-range-segment"][data-range-start="110"][data-range-end="119"]');
  await expect(rangeSegment).toHaveCount(1);

  const segmentPosition = await rangeSegment.evaluate((element) => {
    const style = (element as HTMLElement).style;
    return {
      left: parseFloat(style.left),
      width: parseFloat(style.width),
    };
  });
  expect(segmentPosition.left).toBeGreaterThan(45);
  expect(segmentPosition.left).toBeLessThan(46);
  expect(segmentPosition.width).toBeGreaterThan(4);
  expect(segmentPosition.width).toBeLessThan(5);

  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByRole('button', { name: 'Copy all' }).click();

  await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('src/context-builder.ts');
});

test('session detail minimap jumps to messages and stays synchronized with conversation scroll', async ({ page }) => {
  await page.goto(`/sessions/${fixtureSessionIds[0]}`);

  const scrollViewer = page.getByTestId('conversation-scroll-viewer');
  const minimap = page.getByTestId('session-minimap');
  const indicator = page.getByTestId('session-minimap-indicator');
  const segments = page.getByTestId('session-minimap-segment');

  await expect(scrollViewer).toBeVisible();
  await expect(minimap).toBeVisible();
  await expect(indicator).toBeVisible();
  await expect.poll(() => segments.count()).toBeGreaterThan(6);

  const segmentCount = await segments.count();
  const targetSegment = segments.nth(Math.floor(segmentCount * 0.7));
  const targetId = await targetSegment.getAttribute('data-target-id');
  expect(targetId).toBeTruthy();

  await targetSegment.click();
  const targetMessage = page.locator(`#${targetId}`);
  await expect(targetMessage).toBeVisible();

  await expect.poll(async () => {
    return targetMessage.evaluate((element) => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="conversation-scroll-viewer"]');
      if (!scroller) return Number.POSITIVE_INFINITY;

      const scrollerRect = scroller.getBoundingClientRect();
      const targetRect = element.getBoundingClientRect();
      const scrollerCenter = scrollerRect.top + scrollerRect.height / 2;
      const targetCenter = targetRect.top + targetRect.height / 2;

      return Math.abs(targetCenter - scrollerCenter) / scrollerRect.height;
    });
  }).toBeLessThan(0.45);

  const initialIndicatorTop = await indicator.evaluate((element) => parseFloat(getComputedStyle(element).top));
  await scrollViewer.evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight - element.clientHeight, behavior: 'instant' });
    element.dispatchEvent(new Event('scroll'));
  });

  await expect.poll(async () => {
    return indicator.evaluate((element) => parseFloat(getComputedStyle(element).top));
  }).toBeGreaterThan(initialIndicatorTop + 20);
});

test('session detail keeps tool input and output paired by tool id', async ({ page }) => {
  await page.goto(`/sessions/${toolPairFixtureSessionId}`);

  await page.getByRole('button', { name: /All events/i }).click();

  const pair = page.locator('[data-testid="tool-io-pair"][data-tool-use-id="grep-2-5"][data-tool-result-id="grep-2-5"]');
  await expect(pair).toHaveCount(1);
  await pair.scrollIntoViewIfNeeded();

  await expect(pair).toContainText('Grep');
  await expect(pair).toContainText('FileCacheRepository');
  await expect(pair).toContainText('TOOL_PAIR_SENTINEL_OUTPUT');

  await expect.poll(async () => pair.evaluate((element) => {
    const text = element.textContent || '';
    return text.indexOf('Grep') >= 0 && text.indexOf('TOOL_PAIR_SENTINEL_OUTPUT') > text.indexOf('Grep');
  })).toBe(true);

  await expect(page.locator('[data-testid="tool-io-pair"][data-tool-result-id="grep-2-5"]').filter({ hasNotText: 'Grep' })).toHaveCount(0);

  const standaloneReadPair = page.locator('[data-testid="tool-io-pair"][data-tool-use-id="read-2-6"][data-tool-result-id="read-2-6"]');
  await expect(standaloneReadPair).toHaveCount(1);
  await expect(page.locator('[data-testid="tool-call-inline"][data-tool-call-id="read-2-6"]')).toHaveCount(1);
  await expect(standaloneReadPair).toContainText('Read');
  await expect(standaloneReadPair).toContainText('Loaded src/context-builder.ts lines 110-119.');
});

test('session detail shows compaction markers in transcript and minimap', async ({ page }) => {
  await page.goto(`/sessions/${toolPairFixtureSessionId}`);

  const transcriptMarker = page.getByTestId('conversation-compaction-marker');
  await expect(transcriptMarker).toHaveCount(1);
  await expect(transcriptMarker).toContainText('Context Window Compaction');
  await expect(transcriptMarker.getByTestId('conversation-compaction-line')).toHaveCount(2);

  const minimapCompactionMarker = page.locator('[data-testid="session-minimap-segment"][data-marker-type="compaction"]');
  await expect(minimapCompactionMarker).toHaveCount(1);
  await expect(minimapCompactionMarker).toBeVisible();
  await expect.poll(async () => {
    const minimapBox = await page.getByTestId('session-minimap').boundingBox();
    const markerBox = await minimapCompactionMarker.boundingBox();
    if (!minimapBox || !markerBox) return false;
    return markerBox.width > minimapBox.width && markerBox.height >= 3;
  }).toBe(true);

  const scrollViewer = page.getByTestId('conversation-scroll-viewer');
  await scrollViewer.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
  await minimapCompactionMarker.click();

  await expect.poll(async () => transcriptMarker.evaluate((element) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="conversation-scroll-viewer"]');
    if (!scroller) return Number.POSITIVE_INFINITY;

    const scrollerRect = scroller.getBoundingClientRect();
    const markerRect = element.getBoundingClientRect();
    return Math.abs(markerRect.top - scrollerRect.top) / scrollerRect.height;
  })).toBeLessThan(0.35);

  await expect.poll(async () => {
    const indicatorBox = await page.getByTestId('session-minimap-indicator').boundingBox();
    const markerBox = await minimapCompactionMarker.boundingBox();
    if (!indicatorBox || !markerBox) return false;

    const markerCenter = markerBox.y + markerBox.height / 2;
    return markerCenter >= indicatorBox.y && markerCenter <= indicatorBox.y + indicatorBox.height;
  }).toBe(true);

  await page.getByRole('button', { name: /All events/i }).click();
  const sentinelPair = page.locator('[data-testid="tool-io-pair"][data-tool-use-id="grep-2-5"]');
  const untimestampedSystemEvent = page.locator('[id^="conversation-message-"]').filter({ hasText: 'Untimestamped fixture' }).first();
  const followingUserTurn = page.locator('[id^="conversation-message-"]').filter({ hasText: 'Continue Context Builder pass 5.' }).first();

  await expect(sentinelPair).toContainText('TOOL_PAIR_SENTINEL_OUTPUT');
  await expect(untimestampedSystemEvent).toContainText('Untimestamped fixture');
  await expect(followingUserTurn).toContainText('Continue Context Builder pass 5.');

  await expect.poll(async () => {
    const pairTop = await sentinelPair.evaluate((element) => (element as HTMLElement).offsetTop);
    const untimestampedTop = await untimestampedSystemEvent.evaluate((element) => (element as HTMLElement).offsetTop);
    const markerTop = await transcriptMarker.evaluate((element) => (element as HTMLElement).offsetTop);
    const followingTop = await followingUserTurn.evaluate((element) => (element as HTMLElement).offsetTop);
    return pairTop < untimestampedTop && untimestampedTop < markerTop && markerTop < followingTop;
  }).toBe(true);
});
