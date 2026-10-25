# NexCraft

NexCraft is a Windows desktop app for creating, running and maintaining Minecraft Java Edition servers and their mods. It is built for beginners who want a working modded server without setting up Java or mod loaders by hand, and for server owners who want safe updates, backups and clear diagnostics.

> Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.

## Status

NexCraft is in early development. All four planned milestones are built: servers (Vanilla, Fabric, Quilt, Forge, NeoForge), modpack import, a mod manager and backups.

| Milestone | Scope | State |
| --- | --- | --- |
| 1. Audit | What to reuse from Palnest | Done |
| 2. Foundation | App shell, validated IPC, storage, logging, download queue, process manager, Windows ZIP | Done |
| 3. Vanilla server | Create-server wizard, Java detection and install, EULA consent, start and stop, console, `server.properties` | Done |
| 4. Mods and more | Fabric, Quilt, Forge, NeoForge, CurseForge and Modrinth modpacks, mod manager, backups | Done |

### What works

- **Servers**: create Vanilla, Fabric, Quilt, Forge or NeoForge servers from the official sources, with the right Java found or installed. Start, stop, console, `server.properties`, memory and Java settings, and diagnostics for common crashes.
- **Modpacks**: import a Modrinth `.mrpack` or CurseForge `.zip`, or pick one from search or a link. NexCraft shows what it will install, leaves out client-only mods, and can use CurseForge's official server pack. Files whose authors block app downloads are listed with links; NexCraft never fetches them.
- **Mods**: each mod gets a compatibility label (confirmed, from metadata, suspected conflict, unknown, incompatible) with reasons. Add mods from Modrinth or CurseForge with their required dependencies, check for updates, switch mods off, remove them, and undo any change.
- **Backups**: back up now or on a timer, including while the server runs (saving is paused and the world flushed first). Every archive is checked after writing. Restore previews the change, makes a safety backup first and rolls back on failure.

### Known limits

- CurseForge needs an API key. Release builds include one; builds without it say so and ask for your own key in Settings.
- Mods installed outside NexCraft are recognised on Modrinth by their file hash. CurseForge only recognises mods that NexCraft added itself, so other CurseForge mods are labelled from their own metadata.
- Automatic backups only run while NexCraft is open.
- Builds are not code-signed yet, so Windows SmartScreen may warn on first run.

## Using the portable build

1. Download `NexCraft-<version>-win-x64.zip` from the [latest release](https://github.com/Saiki1997/NexCraft/releases).
2. Extract the whole folder somewhere you can write to (not `Program Files`).
3. Run `NexCraft.exe`.

All data (settings, servers, logs, backups) stays in the `data` folder next to `NexCraft.exe`. Delete `portable.txt` to keep data in your Windows user profile instead.

## Developing

Requires Node.js 22.

```sh
npm ci
npm run dev        # Vite dev server + Electron
npm test           # unit tests (vitest)
npm run test:live  # needs internet: creates, starts, backs up, stops and restores a real server (NEXCRAFT_LIVE=1, NEXCRAFT_LIVE_TYPE=vanilla|fabric|quilt|forge|neoforge)
npm run typecheck
npm run package:win  # Windows x64 ZIP in release/ (run on Windows)
```

### Layout

| Path | What lives there |
| --- | --- |
| `src/shared/` | Data model (zod schemas) and the IPC contract shared by both processes |
| `src/main/core/` | Building blocks: JSON store, logger, download queue, process host, path safety |
| `src/main/services/` | Persisted app state |
| `src/main/servers/` | Server lifecycle, `server.properties`, console diagnostics |
| `src/main/java/` | Java detection, Temurin install, runtime checks |
| `src/main/minecraft/` | Mojang version list and server downloads, Java requirements |
| `src/main/loaders/` | Fabric, Quilt, Forge and NeoForge versions and installers |
| `src/main/providers/` | Modrinth and CurseForge API clients |
| `src/main/modpacks/` | Modpack inspection and import |
| `src/main/mods/` | Mod metadata, compatibility labels, the mod manager and its history |
| `src/main/backups/` | Backups, retention, schedule and restore |
| `src/main/ipc/` | IPC registration with sender and input validation |
| `src/preload/` | The `window.nexcraft` bridge: `invoke` and `on`, nothing else |
| `src/renderer/` | React UI, loaded from disk with a strict Content Security Policy |

### Security rules

- The UI cannot run commands, start arbitrary programs, or read or write arbitrary paths. Every IPC channel is listed in `src/shared/ipc.ts` with a schema, and calls from any page other than NexCraft's own are refused.
- Downloads are HTTPS only, including every redirect, and are verified by size and hash before they are moved into place.
- Archive paths and other untrusted names go through `src/main/core/safe-path.ts`. ZIP extraction refuses links, absolute paths, `..` and zip bombs.
- Mod and backup changes are never destructive: replaced or removed mods move into the server's mod history, and a restore makes a safety backup first.
- NexCraft never accepts the Minecraft EULA for you, only stops servers it started, and stops them with the `stop` command. Force stop needs your confirmation.
- Secrets are encrypted with Windows secure storage and removed from logs.

### CurseForge API key

CurseForge features need an API key. CI injects it at build time from the `CURSEFORGE_API_KEY` repository secret, so it is never stored in the source code. Users can also paste their own key in Settings. Modrinth needs no key.

## License

[MIT](LICENSE)
