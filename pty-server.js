const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { execFileSync } = require('child_process');

const PORT = parseInt(process.env.PTY_PORT || '3456', 10);
const ptys = new Map();
const orphanTimers = new Map();      // id -> timeout handle for grace period cleanup
const orphanBuffers = new Map();     // id -> { chunks: string[], bytes: number } buffered while disconnected
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000; // 24h — survive long laptop-lid closes
const ORPHAN_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2 MB per pty — dropping oldest output on overflow

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

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' }, () => {
  // Signal readiness to parent process
  console.log('READY:' + PORT);
});

wss.on('connection', (ws) => {
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

        // On Windows, wrap non-Claude commands in cmd.exe /c so conpty
        // properly flushes output before the process exits
        let spawnCmd, spawnArgs;
        if (cmd && process.platform === 'win32') {
          spawnCmd = 'cmd.exe';
          spawnArgs = ['/c', cmd, ...(args || [])];
        } else {
          spawnCmd = cmd || CLAUDE_PATH;
          spawnArgs = args || [];
        }

        let p;
        try {
          p = pty.spawn(spawnCmd, spawnArgs, {
            name: 'xterm-256color',
            cols: cols || 120,
            rows: rows || 30,
            cwd: cwd || process.cwd(),
            env: env ? { ...process.env, ...env } : { ...process.env }
          });
        } catch (err) {
          console.error('Failed to spawn pty:', err.message);
          try {
            ws.send(JSON.stringify({ type: 'exit', id, exitCode: 1 }));
          } catch { /* ws closed */ }
          break;
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
            try { p.resize(cols, rows); } catch { /* ignore */ }
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
        if (p) p.write(msg.data);
        break;
      }

      case 'resize': {
        const p = ptys.get(msg.id);
        if (p) p.resize(msg.cols, msg.rows);
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
