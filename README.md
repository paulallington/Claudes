<p align="center">
  <img src="banner.png" alt="Claudes" width="800">
</p>

<p align="center">
  <strong>Run multiple Claude Code instances side-by-side in a desktop app.</strong>
</p>

---

## What is Claudes?

I built Claudes because I like running lots of Claude Code sessions at once and got tired of juggling terminal windows. It's a simple Electron desktop app that lets you run multiple [Claude Code](https://claude.ai/claude-code) CLI sessions in resizable columns, organised by project.

It's not a commercial project — just a tool I made for myself that I thought others might find useful too. If you find a bug or have an idea, feel free to [raise an issue](https://github.com/paulallington/Claudes/issues) or send me a pull request.

## Screenshot

<p align="center">
  <img src="screenshot.png" alt="Claudes in action" width="900">
</p>

## Features

- **Multi-column terminals** — spawn multiple Claude Code instances side-by-side
- **Project workspaces** — add projects via folder picker, switch between them instantly
- **Persistent sessions** — switching projects preserves running Claudes in the background
- **Session resume** — remembers which Claude sessions were open per project and resumes them on restart
- **Resizable columns** — drag handles between columns to resize
- **Keyboard shortcuts**:
  - `Ctrl+Shift+T` — Spawn a new Claude
  - `Ctrl+Shift+W` — Kill focused Claude
  - `Ctrl+Arrow Left/Right` — Navigate between columns
  - `Ctrl+B` — Toggle sidebar

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Claude Code CLI](https://claude.ai/claude-code) installed and available on your PATH

### Setup

```bash
git clone https://github.com/paulallington/Claudes.git
cd Claudes
npm install
npm start
```

A desktop shortcut can be created by running the included `claudes.vbs` via wscript.

## How it works

Claudes runs as an Electron desktop app. Under the hood, it spawns a separate Node.js process (`pty-server.js`) that manages pseudo-terminal instances via [node-pty](https://github.com/microsoft/node-pty). The Electron renderer communicates with the pty server over WebSocket, rendering each terminal with [xterm.js](https://xtermjs.org/).

This architecture avoids the need to compile native modules against Electron's Node.js headers — `node-pty` runs under the system Node.js using its prebuilt binaries.

Session state is saved per project (in `.claudes/sessions.json` within the project directory), so when you restart the app your Claude sessions are automatically resumed.

## Project structure

```
Claudes/
  main.js          — Electron main process
  pty-server.js    — WebSocket + node-pty server (runs under system Node.js)
  preload.js       — Electron context bridge
  renderer.js      — Frontend: columns, terminals, project management
  index.html       — App shell
  styles.css       — Dark theme
  icon.ico         — App icon
```

## Contributing

This is a personal project, but contributions are welcome! If you run into a problem, [open an issue](https://github.com/paulallington/Claudes/issues). If you want to add something, send a pull request and I'll take a look.

## License

See [LICENSE](LICENSE) for details. Free to use, but the source code may not be modified or redistributed without permission.

---

<p align="center">
  A <a href="https://www.thecodeguy.co.uk">The Code Guy</a> project
</p>
