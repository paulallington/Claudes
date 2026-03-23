# Launch Configurations — Design Spec

## Problem

The current Run tab discovers launch configs from `.vscode/launch.json` and .NET `launchSettings.json` files, but:

1. **dotnet run fails** when a directory contains multiple `.csproj` files — no `--project` flag is passed
2. **No env var support** beyond what's in `launchSettings.json` profiles — no way to configure env vars like in Rider
3. **No custom configs** — users can't create their own launch profiles for arbitrary commands
4. **No editing** — all configs are read-only auto-discovered entries

## Solution

A dedicated launch configuration panel with auto-discovery, a config editor, environment profiles, and typed presets for common runtimes.

---

## Section 1: Config Discovery & Storage

### Auto-discovered configs (read-only)

- **`.vscode/launch.json`** — parsed as today (coreclr, node, pwa-node types)
- **`Properties/launchSettings.json`** — scanned recursively as today, with enhancements:
  - For each directory containing a `launchSettings.json`, also scan for `.csproj` files
  - If multiple `.csproj` found, create one config entry per (profile x csproj) combination
  - Config name becomes `"ProfileName (ProjectFile.csproj)"`
  - `dotnet run` gets `--project path/to/Specific.csproj`
  - Even for single-`.csproj` directories, the `project` field is always populated and `--project` is always passed — this is safer and more predictable
- Auto-discovered configs use type `dotnet-run` (replacing the old `dotnet-project` type name — the existing `launchConfig()` switch will be updated in the same change)
- Auto-discovered configs display with a source badge via a `_source` field on each config (e.g. `"launchSettings"`, `"launch.json"`)
- A "Clone" action copies an auto-discovered config into `.claudes/launch.json` for editing:
  - Name gets suffixed with `" (Copy)"`
  - All fields are copied, type is preserved as `dotnet-run`
  - The editor opens immediately for the cloned config
  - `launchSettings.json` `environmentVariables` are copied into the config's `env` field

### Custom configs

Stored in `<project>/.claudes/launch.json`:

```json
{
  "configurations": [
    {
      "name": "My API Server",
      "type": "dotnet-run",
      "project": "src/MyApi/MyApi.csproj",
      "applicationUrl": "https://localhost:5001",
      "envProfile": "Development",
      "env": { "MY_VAR": "value" },
      "args": "--verbose"
    },
    {
      "name": "Frontend Dev",
      "type": "custom",
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "${workspaceFolder}/frontend",
      "env": { "PORT": "3000" }
    }
  ]
}
```

### Env profiles

Stored in `<project>/.claudes/env-profiles.json`:

```json
{
  "Development": {
    "ASPNETCORE_ENVIRONMENT": "Development",
    "ConnectionStrings__Default": "Server=localhost;Database=mydb"
  },
  "Staging": {
    "ASPNETCORE_ENVIRONMENT": "Staging",
    "API_URL": "https://staging.example.com"
  }
}
```

- Profiles are project-wide — any config can reference any profile by name
- When launching, env profile vars are merged with config-level env vars (config vars take precedence)
- `.env` file support: profiles can include `"_envFile": "path/to/.env"` to load from a file
- Full env merge chain (highest priority first): `config.env` > `config.envFile` > `profile key-value pairs` > `profile._envFile`
- Example: if profile sets `PORT=3000` and config sets `PORT=5000`, the process gets `PORT=5000`

---

## Section 2: Config Types & Smart Defaults

### Typed presets

| Type | Command | Smart defaults |
|------|---------|---------------|
| `dotnet-run` | `dotnet run` | Scans for `.csproj` files in project, shows dropdown. Auto-populates `applicationUrl` from `launchSettings.json` if present. Adds `--project` flag. |
| `dotnet-exec` | `dotnet <dll>` | Browse for `.dll` in `bin/` directories |
| `node` | `node` / custom runtime | Detects `package.json` scripts, can pick a script or specify entry file |
| `python` | `python` | Detects `venv`/`.venv`, uses venv's Python binary directly (`.venv/bin/python` or `.venv\Scripts\python.exe`) rather than activating. Pick script file. |
| `custom` | Any command | Fully manual — command, args, cwd, env. No auto-detection. |

### Type-specific fields

- **`dotnet-run`**: project (`.csproj` picker), applicationUrl, framework (maps to `dotnet run --framework <tfm>`), commandLineArgs, envProfile
- **`dotnet-exec`**: program (`.dll` path), args, envProfile
- **`node`**: program or script name, runtimeExecutable, runtimeArgs, args, envProfile
- **`python`**: script, interpreter path, args, envProfile
- **`custom`**: command, args (as string or array), cwd, envProfile

### Common fields (all types)

- Name, working directory, environment variables (key-value table), env profile (dropdown), env file path

### Variable substitution

`${workspaceFolder}` resolves to the project root (same as today).

---

## Section 3: Panel UI Layout

The Run tab in the explorer panel gets replaced with a two-state layout.

### State 1 — Config List (default view)

- Top bar: "Launch Configurations" header with `+` (Add) and refresh buttons
- List of all configs, grouped by source:
  - **Custom** (from `.claudes/launch.json`) — shown first
  - **launchSettings** — auto-discovered .NET profiles
  - **launch.json** — VS Code configs
- Each config item shows:
  - Play button (left) — launches immediately
  - Config name
  - Type badge (e.g. `dotnet-run`, `node`, `custom`)
  - Edit pencil icon (right) — opens editor for custom configs
  - Clone icon — for auto-discovered configs (creates editable copy)
- Group headers are collapsible

### State 2 — Config Editor (when editing/adding)

- Back arrow + config name header at top
- Form sections (collapsible):
  - **General**: Name, Type (dropdown — changes which fields appear below)
  - **Command**: Type-specific fields (e.g. `.csproj` picker for dotnet-run, command field for custom)
  - **Arguments**: Command line args (text field)
  - **Working Directory**: Path field with browse button
  - **Environment**:
    - Env Profile dropdown (from `env-profiles.json`, plus "None")
    - "Manage Profiles" link — opens a sub-view to add/edit/delete env profiles
    - Key-value table for config-level overrides (add/remove rows)
    - Env file path (optional, with browse)
  - **URL**: applicationUrl field (for web apps), with "Open browser on launch" checkbox
- Footer: Save / Cancel / Delete buttons

### Env Profile Manager (sub-view from editor)

- Stacked layout (sidebar is narrow): profile list at top, key-value editor below
- Add/rename/delete profiles
- Each profile is a key-value table + optional `.env` file reference
- Back button returns to the config editor

---

## Section 4: Launch Behavior

### When the user clicks Play

1. Resolve the config: merge env vars using the full chain (highest priority first): `config.env` > `config.envFile` > `profile key-value pairs` > `profile._envFile`
2. Build the command based on type:
   - `dotnet-run`: `dotnet run --project <csproj> [--urls <url>] [-- <args>]`
   - `dotnet-exec`: `dotnet <dll> [<args>]`
   - `node`: `<runtime> [runtimeArgs] <program> [args]`
   - `python`: `python <script> [args]`
   - `custom`: `<command> [args]`
3. Spawn a new column with the process (using existing `addColumn` with `cmd`, `title`, `cwd`, `env` params)
4. Column title shows the config name
5. If `applicationUrl` is set and "Open browser on launch" is enabled, open the URL in the default browser after a brief delay (or when the process outputs a "listening" message)

### Re-run behavior

- If a column was launched from a config and is still running, clicking Play again shows a prompt: "Already running. Kill and restart?"
- The column header shows a small indicator that it was launched from a config (to distinguish from manual Claude spawns)

### Error handling

- If the command fails to spawn (e.g. `dotnet` not on PATH), show an error notification (using existing notification system)
- If a `.csproj` or program path doesn't exist, show an error before attempting to spawn

### Validation & malformed configs

- If `.claudes/launch.json` or `.claudes/env-profiles.json` contain invalid JSON, show a notification and fall back to an empty list for that source
- Required fields per type: all types require `name` and `type`; `dotnet-run` requires `project`; `custom` requires `command`
- Configs with unknown `type` values are shown in the list with a warning badge but can still be launched if they have a `command` field (treated as `custom`); otherwise they are skipped
- Args are always stored as arrays internally; string values in config files are split on whitespace when loaded

---

## Section 5: Data Flow & Architecture

### Main process (main.js)

- Existing `launch:getConfigs` IPC handler enhanced to:
  - Read `.claudes/launch.json` for custom configs
  - Read `.claudes/env-profiles.json` for profiles
  - Enhanced `.csproj` scanning: find all `.csproj` files in each `launchSettings.json` directory and create per-project entries
  - Return `{ configs: [...], envProfiles: {...} }` instead of just an array (each config carries its own `_source` field)
  - **Breaking change**: the renderer must be updated in the same step to destructure `{ configs, envProfiles }` from the response
- New IPC handlers:
  - `launch:saveConfigs` — write custom configs to `.claudes/launch.json`
  - `launch:saveEnvProfiles` — write profiles to `.claudes/env-profiles.json`
  - `launch:scanCsproj` — given a directory, return list of `.csproj` files (for the picker)
  - `launch:browseFile` — open native file dialog filtered by extension
  - `launch:readEnvFile` — parse a `.env` file and return key-value pairs

### Preload (preload.js)

- Expose the new IPC channels through `contextBridge`

### Renderer (renderer.js)

- Replace `refreshRunConfigs()` and `launchConfig()` with the new panel logic
- Config list view: renders grouped config items with play/edit/clone actions
- Config editor view: dynamic form that adapts fields based on selected type
- Env profile manager: sub-view for CRUD on profiles
- All state kept in memory, persisted via IPC on save

### No new files

All logic stays in the existing three JS files (`main.js`, `preload.js`, `renderer.js`), consistent with the current architecture.
