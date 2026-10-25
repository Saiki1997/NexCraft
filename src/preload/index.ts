/**
 * The only bridge between the page and the main process. It exposes `invoke`
 * for the channels in shared/ipc.ts and `on` for the main process's events,
 * nothing else: no Node APIs, no ipcRenderer, no arbitrary channels.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { Channel, EventName, NexcraftBridge } from "../shared/ipc";
import { CHANNEL_NAMES, EVENT_NAMES } from "../shared/ipc-names";

const allowedChannels = new Set<string>(CHANNEL_NAMES);
const allowedEvents = new Set<string>(EVENT_NAMES);

const bridge: NexcraftBridge = {
  invoke(channel: Channel, input: unknown) {
    if (!allowedChannels.has(channel)) return Promise.resolve({ ok: false, code: "failed", error: `Unknown channel ${channel}` });
    return ipcRenderer.invoke(channel, input);
  },
  on(event: EventName, listener: (payload: never) => void) {
    if (!allowedEvents.has(event)) throw new Error(`Unknown event ${event}`);
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },
} as NexcraftBridge;

contextBridge.exposeInMainWorld("nexcraft", bridge);
