import { _electron, test, expect, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const electronBin = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');

let app: ElectronApplication;
let win: Page;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  app = await _electron.launch({
    args: [repoRoot],
    executablePath: electronBin,
    cwd: repoRoot,
    timeout: 30_000,
  });
  win = await app.firstWindow({ timeout: 15_000 });
  win.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));
  win.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  // Wait 5s for any boot errors to surface.
  await win.waitForTimeout(5_000);
});

test.afterAll(async () => {
  if (app) await app.close();
});

// Helper: click via raw DOM (workaround for Playwright Electron click no-op quirk).
async function evalClick(selector: string) {
  await win.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) el.click();
  }, selector);
}

// ─── Group A: Boot + sentinel symbols ────────────────────────────────────────

test('A1 main window opens within 15s', async () => {
  expect(win).toBeTruthy();
  const title = await win.title();
  expect(typeof title).toBe('string');
});

test('A2 no pageerror events during first 5s', async () => {
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

test('A3 no Uncaught/ReferenceError/TypeError in console', async () => {
  const bad = consoleErrors.filter((m) =>
    /Uncaught|ReferenceError|TypeError/.test(m)
  );
  expect(bad, bad.join('\n')).toEqual([]);
});

// ─── Group B: Toolbar surface ────────────────────────────────────────────────

test('B4 #btn-session-search exists', async () => {
  await expect(win.locator('#btn-session-search')).toHaveCount(1);
});

test('B5 #btn-broadcast exists', async () => {
  await expect(win.locator('#btn-broadcast')).toHaveCount(1);
});

test('B6 #btn-snippets exists', async () => {
  await expect(win.locator('#btn-snippets')).toHaveCount(1);
});

test('B7 #btn-shortcuts exists', async () => {
  await expect(win.locator('#btn-shortcuts')).toHaveCount(1);
});

test('B8 #btn-automations-flyout exists with aria-label="Automations"', async () => {
  const loc = win.locator('#btn-automations-flyout');
  await expect(loc).toHaveCount(1);
  await expect(loc).toHaveAttribute('aria-label', 'Automations');
});

test('B9 #btn-sticky-notes exists (yours preserved)', async () => {
  await expect(win.locator('#btn-sticky-notes')).toHaveCount(1);
});

test('B10 .toolbar-divider exists', async () => {
  const count = await win.locator('.toolbar-divider').count();
  expect(count).toBeGreaterThanOrEqual(1);
});

// ─── Group C: Modal/panel opens ──────────────────────────────────────────────

test('C11 shortcuts modal opens on click', async () => {
  // Modal is #shortcuts-modal; opens by removing 'hidden' class.
  // Click with normal Playwright click first; fall back to evaluate-click if quirk hits.
  try {
    await win.locator('#btn-shortcuts').click({ timeout: 1_500 });
  } catch {
    await evalClick('#btn-shortcuts');
  }
  // Confirm it's visible — `.modal-overlay:not(.hidden)` is the sentinel pattern.
  await expect(win.locator('#shortcuts-modal')).not.toHaveClass(/hidden/, { timeout: 2_000 });
});

test('C12 shortcuts modal closes on Escape', async () => {
  // Modal is open from C11; send Escape.
  await win.keyboard.press('Escape');
  await expect(win.locator('#shortcuts-modal')).toHaveClass(/hidden/, { timeout: 2_000 });
});

test('C13 settings dialog opens and has width >= 680px', async () => {
  // Open toolbar menu, then click "Settings".
  try {
    await win.locator('#btn-toolbar-menu').click({ timeout: 1_500 });
  } catch {
    await evalClick('#btn-toolbar-menu');
  }
  // Give the dropdown a tick to render.
  await win.waitForTimeout(200);
  try {
    await win.locator('#btn-settings').click({ timeout: 1_500 });
  } catch {
    await evalClick('#btn-settings');
  }
  // Settings modal becomes visible.
  await expect(win.locator('#settings-modal')).not.toHaveClass(/hidden/, { timeout: 2_000 });
  // The dialog element is .settings-dialog; check its computed width.
  const width = await win.evaluate(() => {
    const el = document.querySelector('.settings-dialog') as HTMLElement | null;
    if (!el) return -1;
    return el.getBoundingClientRect().width;
  });
  expect(width).toBeGreaterThanOrEqual(680);
});

test('C14 settings dialog has more than 3 tabs', async () => {
  // Settings modal still open from C13.
  const tabCount = await win.locator('.settings-tabs > *').count();
  expect(tabCount).toBeGreaterThan(3);
  // Close the settings modal so we leave a clean state.
  try {
    await win.locator('#settings-close').click({ timeout: 1_000 });
  } catch {
    await evalClick('#settings-close');
  }
});

// ─── Group D: JS evaluation sentinels ────────────────────────────────────────

test('D15 window.electronAPI exposes expected methods', async () => {
  const shape = await win.evaluate(() => {
    const api: any = (window as any).electronAPI;
    return {
      exists: !!api,
      openExternal: typeof api?.openExternal,
      getProjects: typeof api?.getProjects,
      saveProjects: typeof api?.saveProjects,
    };
  });
  expect(shape.exists).toBe(true);
  expect(shape.openExternal).toBe('function');
  expect(shape.getProjects).toBe('function');
  expect(shape.saveProjects).toBe('function');
});

test('D16 theirs setupShortcutsModal + yours sticky-notes global both present', async () => {
  // setupShortcutsModal is an IIFE — by the time it has run, it's no longer addressable as a
  // function name in the global scope. Instead, verify its observable effect: the #shortcuts-modal
  // element exists in the DOM (theirs added it during merge).
  const probe = await win.evaluate(() => {
    return {
      theirsShortcutsModalDom: !!document.getElementById('shortcuts-modal'),
      theirsShortcutsCloseDom: !!document.getElementById('shortcuts-close'),
      yoursStickyNotesGlobal: typeof (window as any).__renderStickyNotesForActiveProject,
    };
  });
  expect(probe.theirsShortcutsModalDom).toBe(true);
  expect(probe.theirsShortcutsCloseDom).toBe(true);
  expect(probe.yoursStickyNotesGlobal).toBe('function');
});
