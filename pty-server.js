const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { execFileSync } = require('child_process');

const PORT = parseInt(process.env.PTY_PORT || '3456', 10);
const ptys = new Map();

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

        let p;
        try {
          p = pty.spawn(cmd || CLAUDE_PATH, args || [], {
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
        connectionPtys.add(id);

        p.onData((data) => {
          try {
            ws.send(JSON.stringify({ type: 'data', id, data }));
          } catch { /* ws closed */ }
        });

        p.onExit(({ exitCode }) => {
          ptys.delete(id);
          connectionPtys.delete(id);
          try {
            ws.send(JSON.stringify({ type: 'exit', id, exitCode }));
          } catch { /* ws closed */ }
        });

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
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    for (const id of connectionPtys) {
      const p = ptys.get(id);
      if (p) {
        p.kill();
        ptys.delete(id);
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
