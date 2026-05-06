const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { execFileSync } = require('child_process');

const PORT = parseInt(process.env.PTY_PORT || '3456', 10);
const AUTH_TOKEN = process.env.PTY_AUTH_TOKEN || '';
// Subprotocol the renderer presents on the WebSocket handshake. The token is
// passed via env from the parent Electron process and never logged. If the
// token is missing or wrong, handleProtocols returns false and the WS
// handshake fails — closing the local-RCE drive-by vector where any browser
// page could `new WebSocket('ws://127.0.0.1:<port>')` and spawn processes.
const AUTH_PROTOCOL_PREFIX = 'claudes-auth-';
const ptys = new Map();
const orphanTimers = new Map();      // id -> timeout handle for grace period cleanup
const orphanBuffers = new Map();     // id -> { chunks: string[], bytes: number } buffered while disconnected
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000; // 24h — survive long laptop-lid closes
const ORPHAN_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2 MB per pty — dropping oldest output on overflow
// Caps to bound DoS exposure even from an authenticated peer.
const MAX_WS_PAYLOAD = 1 * 1024 * 1024;        // 1 MB per message — generous for paste, way under fork-bomb territory
const MAX_PTYS_GLOBAL = 256;                    // hard ceiling across the process
const MAX_PTYS_PER_CONNECTION = 64;             // per renderer
const MAX_WRITE_BYTES = 256 * 1024;             // 256 KB per write — single keystroke / paste batch
const MAX_COLS = 1000;
const MAX_ROWS = 1000;

// Strip env keys that change interpreter loading or process behavior. A
// renderer can set per-spawn env (legit: ANTHROPIC_BASE_URL etc.) but must
// not be able to inject NODE_OPTIONS / LD_PRELOAD / DYLD_INSERT_LIBRARIES /
// PATH override and turn an allow-listed `claude` invocation into RCE.
const ENV_BLOCKLIST = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_PRESERVE_SYMLINKS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
  'PERL5LIB', 'PERL5OPT', 'RUBYLIB', 'RUBYOPT',
  'PATH', 'Path' // PATH is intentionally excluded so a renderer can't shadow `claude` or `node` with an attacker-controlled directory.
]);
function sanitiseEnv(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of Object.keys(input)) {
    if (typeof input[k] !== 'string') continue;
    if (ENV_BLOCKLIST.has(k)) continue;
    if (/^LD_/.test(k) || /^DYLD_/.test(k)) continue;
    out[k] = input[k];
  }
  return out;
}

// Resolve claude executable path
function findClaude() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  try {
    return execFileSync('where', ['claude'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {
    return 'claude.exe';
  }
}

const CLAUDE_PATH = findClaude();

// Run claude update at startup (non-blocking)
try {
  const { execFile } = require('child_process');
  execFile(CLAUDE_PATH, ['update'], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('claude update failed:', err.message);
    } else {
      const output = (stdout || '').trim();
      if (output) console.log('claude update:', output);
    }
  });
} catch (err) {
  console.error('claude update failed:', err.message);
}

const wss = new WebSocketServer({
  port: PORT,
  host: '127.0.0.1',
  maxPayload: MAX_WS_PAYLOAD,
  // Reject the WS handshake unless the renderer presents the per-launch
  // token as a Sec-WebSocket-Protocol entry. A drive-by browser page won't
  // know the token and is refused before any message is processed.
  handleProtocols: (protocols /*, req*/) => {
    if (!AUTH_TOKEN) return false; // misconfigured launch — fail closed
    const wanted = AUTH_PROTOCOL_PREFIX + AUTH_TOKEN;
    for (const p of protocols) if (p === wanted) return p;
    return false;
  }
}, () => {
  // Signal readiness to parent process
  console.log('READY:' + PORT);
});

wss.on('connection', (ws, req) => {
  // Belt-and-braces: if for any reason a connection lands here without the
  // authenticated subprotocol selected, drop it.
  if (!ws.protocol || ws.protocol !== AUTH_PROTOCOL_PREFIX + AUTH_TOKEN) {
    try { ws.close(1008, 'unauthorized'); } catch { /* ignore */ }
    return;
  }
  const connectionPtys = new Set();

  // Wire up a pty's data/exit events to this WebSocket
  function attachPty(id, p) {
    connectionPtys.add(id);

    p._dataHandler = (data) => {
      if (ws.readyState === 1 /* OPEN */) {
        try {
          ws.send(JSON.stringify({ type: 'data', id, data }));
        } catch { /* ws closed */ }
      } else {
        // Buffer output while disconnected, capped at ORPHAN_BUFFER_MAX_BYTES.
        // Otherwise a chatty Claude session can leak GBs of RAM during a 24h
        // orphan grace window.
        let buf = orphanBuffers.get(id);
        if (!buf) { buf = { chunks: [], bytes: 0 }; orphanBuffers.set(id, buf); }
        const size = Buffer.byteLength(data, 'utf8');
        buf.chunks.push(data);
        buf.bytes += size;
        while (buf.bytes > ORPHAN_BUFFER_MAX_BYTES && buf.chunks.length > 1) {
          const dropped = buf.chunks.shift();
          buf.bytes -= Buffer.byteLength(dropped, 'utf8');
        }
      }
    };

    p._exitHandler = ({ exitCode }) => {
      if (ptys.get(id) === p) {
        ptys.delete(id);
        connectionPtys.delete(id);
        clearOrphanTimer(id);
        orphanBuffers.delete(id);
        setTimeout(() => {
          try {
            ws.send(JSON.stringify({ type: 'exit', id, exitCode, lifetime_ms: p._createdAt ? (Date.now() - p._createdAt) : null }));
          } catch { /* ws closed */ }
        }, 200);
      }
    };

    // node-pty disposables
    p._dataDisposable = p.onData(p._dataHandler);
    p._exitDisposable = p.onExit(p._exitHandler);
  }

  function clearOrphanTimer(id) {
    const timer = orphanTimers.get(id);
    if (timer) { clearTimeout(timer); orphanTimers.delete(id); }
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create': {
        const { id, cols, rows, cwd, args, cmd, env } = msg;

        // Reject if global or per-connection caps would be exceeded. Without
        // these, an authenticated peer can fork-bomb the host by looping
        // 'create' messages.
        if (ptys.size >= MAX_PTYS_GLOBAL || connectionPtys.size >= MAX_PTYS_PER_CONNECTION) {
          try { ws.send(JSON.stringify({ type: 'exit', id, exitCode: 1 })); } catch { /* ws closed */ }
          break;
        }

        const safeCols = Math.max(1, Math.min(MAX_COLS, parseInt(cols, 10) || 120));
        const safeRows = Math.max(1, Math.min(MAX_ROWS, parseInt(rows, 10) || 30));

        // Spawn directly so the child process owns the conpty: this matters
        // for interactive long-running run-tab launches (dotnet run, blazor,
        // npm start, python REPL) — under a cmd.exe /c wrapper the inner
        // process saw a piped stdout and switched to buffered/non-interactive
        // mode, hiding streaming output and breaking stdin/Ctrl+C delivery.
        // The 200ms exit-delay below covers the "flush before exit" case for
        // short-lived commands, so the wrapper is no longer needed.
        const ptyOpts = {
          name: 'xterm-256color',
          cols: safeCols,
          rows: safeRows,
          cwd: cwd || process.cwd(),
          // Filter the renderer-supplied env so it cannot inject NODE_OPTIONS,
          // LD_PRELOAD, PATH overrides, etc. The parent process env is still
          // inherited (so legitimate vars like USERPROFILE, HOME, locale set
          // by Electron flow through), only the per-spawn additions are
          // blocklist-checked.
          env: { ...process.env, ...(sanitiseEnv(env) || {}) }
        };

        let p;
        try {
          p = pty.spawn(cmd || CLAUDE_PATH, args || [], ptyOpts);
        } catch (err) {
          // Direct spawn failed — usually because the bare name didn't
          // resolve via PATHEXT (e.g. .cmd shims like npm.cmd, yarn.cmd).
          // Fall back to cmd.exe /c on Windows so the shell does the
          // resolution. Output streaming for the inner process won't be
          // as good under the wrapper, but at least it'll launch.
          if (cmd && process.platform === 'win32') {
            try {
              p = pty.spawn('cmd.exe', ['/c', cmd, ...(args || [])], ptyOpts);
            } catch (err2) {
              console.error('Failed to spawn pty (direct + cmd.exe fallback):', err.message, '/', err2.message);
              try { ws.send(JSON.stringify({ type: 'exit', id, exitCode: 1 })); } catch { /* ws closed */ }
              break;
            }
          } else {
            console.error('Failed to spawn pty:', err.message);
            try { ws.send(JSON.stringify({ type: 'exit', id, exitCode: 1 })); } catch { /* ws closed */ }
            break;
          }
        }

        ptys.set(id, p);
        p._createdAt = Date.now();
        attachPty(id, p);
        break;
      }

      case 'reattach': {
        // Re-wire an existing pty to this new WebSocket connection
        const { id, cols, rows } = msg;
        const p = ptys.get(id);
        if (p) {
          // Cancel the orphan kill timer
          clearOrphanTimer(id);

          // Detach old listeners
          if (p._dataDisposable) p._dataDisposable.dispose();
          if (p._exitDisposable) p._exitDisposable.dispose();

          // Re-attach to the new ws
          attachPty(id, p);

          // Resize to current terminal dimensions
          if (cols && rows) {
            const safeCols = Math.max(1, Math.min(MAX_COLS, parseInt(cols, 10) || 120));
            const safeRows = Math.max(1, Math.min(MAX_ROWS, parseInt(rows, 10) || 30));
            try { p.resize(safeCols, safeRows); } catch { /* ignore */ }
          }

          // Flush any buffered output
          const buf = orphanBuffers.get(id);
          if (buf) {
            for (const data of buf.chunks) {
              try {
                ws.send(JSON.stringify({ type: 'data', id, data }));
              } catch { break; }
            }
            orphanBuffers.delete(id);
          }

          ws.send(JSON.stringify({ type: 'reattached', id }));
        } else {
          // Pty is gone (exited or was killed during sleep)
          ws.send(JSON.stringify({ type: 'reattach-failed', id }));
        }
        break;
      }

      case 'write': {
        const p = ptys.get(msg.id);
        if (!p) break;
        const data = typeof msg.data === 'string' ? msg.data : '';
        if (Buffer.byteLength(data, 'utf8') > MAX_WRITE_BYTES) break;
        p.write(data);
        break;
      }

      case 'resize': {
        const p = ptys.get(msg.id);
        if (!p) break;
        const safeCols = Math.max(1, Math.min(MAX_COLS, parseInt(msg.cols, 10) || 0));
        const safeRows = Math.max(1, Math.min(MAX_ROWS, parseInt(msg.rows, 10) || 0));
        if (safeCols && safeRows) p.resize(safeCols, safeRows);
        break;
      }

      case 'kill': {
        const p = ptys.get(msg.id);
        if (p) {
          p.kill();
          ptys.delete(msg.id);
          connectionPtys.delete(msg.id);
          clearOrphanTimer(msg.id);
          orphanBuffers.delete(msg.id);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    // Don't kill ptys — orphan them with a grace period so the renderer can reattach
    for (const id of connectionPtys) {
      const p = ptys.get(id);
      if (p) {
        // Start buffering output (don't overwrite if handler already started buffering)
        if (!orphanBuffers.has(id)) orphanBuffers.set(id, { chunks: [], bytes: 0 });

        // Set a grace timer — if no reattach within the window, kill the pty
        orphanTimers.set(id, setTimeout(() => {
          const pty = ptys.get(id);
          if (pty) {
            console.log(`Orphan grace expired for pty ${id}, killing`);
            pty.kill();
            ptys.delete(id);
          }
          orphanTimers.delete(id);
          orphanBuffers.delete(id);
        }, ORPHAN_GRACE_MS));
      }
    }
    connectionPtys.clear();
  });
});

process.on('SIGINT', () => {
  for (const [id, p] of ptys) {
    p.kill();
  }
  process.exit();
});

process.on('SIGTERM', () => {
  for (const [id, p] of ptys) {
    p.kill();
  }
  process.exit();
});
