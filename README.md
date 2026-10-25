# NexCraft

NexCraft is a Windows desktop app for creating, running and maintaining Minecraft Java Edition servers and their mods. It is built for beginners who want a working modded server without setting up Java or mod loaders by hand, and for server owners who want safe updates, backups and clear diagnostics.

> Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.

## Status

NexCraft is in early development. This build contains the application foundation. Server creation arrives in milestone 3.

| Milestone | Scope | State |
| --- | --- | --- |
| 1. Audit | What to reuse from Palnest | Done |
| 2. Foundation | App shell, validated IPC, storage, logging, download queue, process manager, Windows ZIP | This build |
| 3. Vanilla server | Create-server wizard, Java detection and install, EULA consent, start and stop, console, `server.properties` | Next |
| 4. Mods and more | Fabric, Quilt, Forge, NeoForge, CurseForge and Modrinth modpacks, mod manager, backups | Planned |

## Using the portable build

1. Download `NexCraft-<version>-win-x64.zip` from the latest CI run or release.
2. Extract the whole folder somewhere you can write to (not `Program Files`).
3. Run `NexCraft.exe`.

All data (settings, servers, logs, backups) stays in the `data` folder next to `NexCraft.exe`. Delete `portable.txt` to keep data in your Windows user profile instead.

## Developing

Requires Node.js 22.

```sh
npm ci
npm run dev        # Vite dev server + Electron
npm test           # unit tests (vitest)
npm run typecheck
npm run package:win  # Windows x64 ZIP in release/ (run on Windows)
```

### Layout

| Path | What lives there |
| --- | --- |
| `src/shared/` | Data model (zod schemas) and the IPC contract shared by both processes |
| `src/main/core/` | Building blocks: JSON store, logger, download queue, process host, path safety |
| `src/main/services/` | App services (state today; servers, Java, modpacks and backups next) |
| `src/main/ipc/` | IPC registration with sender and input validation |
| `src/preload/` | The `window.nexcraft` bridge: `invoke` and `on`, nothing else |
| `src/renderer/` | React UI, loaded from disk with a strict Content Security Policy |

### Security rules

- The UI cannot run commands, start arbitrary programs, or read or write arbitrary paths. Every IPC channel is listed in `src/shared/ipc.ts` with a schema, and calls from any page other than NexCraft's own are refused.
- Downloads are HTTPS only, including every redirect, and are verified by size and hash before they are moved into place.
- Archive paths and other untrusted names go through `src/main/core/safe-path.ts`.
- Secrets are encrypted with Windows secure storage and removed from logs.

### CurseForge API key

CurseForge features need an API key. CI injects it at build time from the `CURSEFORGE_API_KEY` repository secret, so it is never stored in the source code. Users can also paste their own key in Settings. Modrinth needs no key.

## License

[MIT](LICENSE)
