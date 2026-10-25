# NexCraft

NexCraft is a Windows desktop app for creating, running and maintaining Minecraft Java Edition servers and their mods. It is built for beginners who want a working modded server without setting up Java or mod loaders by hand, and for server owners who want safe updates, backups and clear diagnostics.

> Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.

## Status

NexCraft is in early development. This build creates and runs Vanilla, Fabric, Quilt, Forge and NeoForge servers. Modpacks, the mod manager and backups are still being built as part of milestone 4.

| Milestone | Scope | State |
| --- | --- | --- |
| 1. Audit | What to reuse from Palnest | Done |
| 2. Foundation | App shell, validated IPC, storage, logging, download queue, process manager, Windows ZIP | Done |
| 3. Vanilla server | Create-server wizard, Java detection and install, EULA consent, start and stop, console, `server.properties` | Done |
| 4. Mods and more | Fabric, Quilt, Forge and NeoForge servers | Done |
| | CurseForge and Modrinth modpacks, mod manager, backups | In progress |

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
npm run test:live  # needs internet: creates, starts and stops a real Vanilla server (NEXCRAFT_LIVE=1)
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
| `src/main/ipc/` | IPC registration with sender and input validation |
| `src/preload/` | The `window.nexcraft` bridge: `invoke` and `on`, nothing else |
| `src/renderer/` | React UI, loaded from disk with a strict Content Security Policy |

### Security rules

- The UI cannot run commands, start arbitrary programs, or read or write arbitrary paths. Every IPC channel is listed in `src/shared/ipc.ts` with a schema, and calls from any page other than NexCraft's own are refused.
- Downloads are HTTPS only, including every redirect, and are verified by size and hash before they are moved into place.
- Archive paths and other untrusted names go through `src/main/core/safe-path.ts`. ZIP extraction refuses links, absolute paths, `..` and zip bombs.
- NexCraft never accepts the Minecraft EULA for you, only stops servers it started, and stops them with the `stop` command. Force stop needs your confirmation.
- Secrets are encrypted with Windows secure storage and removed from logs.

### CurseForge API key

CurseForge features need an API key. CI injects it at build time from the `CURSEFORGE_API_KEY` repository secret, so it is never stored in the source code. Users can also paste their own key in Settings. Modrinth needs no key.

## License

[MIT](LICENSE)
