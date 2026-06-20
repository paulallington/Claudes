// Canonical "reveal" for a BrowserWindow-like object. Used whenever the app
// needs to bring its window to the foreground: tray click, app activate, and
// the single-instance second-instance handler (taskbar relaunch). A window that
// started hidden in the tray (start-at-login) is NOT "minimized", so a
// restore+focus alone leaves nothing on screen — we always show() too.
// Pure + defensive so it's unit-testable and safe against null/destroyed wins.
// @param win  BrowserWindow-like { isDestroyed?, isMinimized?, restore, show, focus }
function revealWindow(win) {
  if (!win) return;
  if (win.isDestroyed && win.isDestroyed()) return;
  if (win.isMinimized && win.isMinimized()) {
    if (win.restore) win.restore();
  }
  if (win.show) win.show();
  if (win.focus) win.focus();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { revealWindow: revealWindow };
}
if (typeof window !== 'undefined') {
  window.WindowReveal = { revealWindow: revealWindow };
}
