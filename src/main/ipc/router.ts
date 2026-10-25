/**
 * Registers IPC handlers. Every call is checked twice before a handler runs:
 * the sender must be NexCraft's own window, and the input must match the
 * channel's zod schema from `shared/ipc.ts`. Errors come back as data.
 */
import type { z } from "zod";
import { channels, type Channel, type ChannelOutput, type IpcResult } from "../../shared/ipc";
import type { ScopedLogger } from "../core/logger";

export interface IpcMainLike {
  handle(channel: string, listener: (event: { senderFrame?: { url: string } | null }, ...args: unknown[]) => unknown): void;
}

export type Handlers = {
  [C in Channel]: (input: z.output<(typeof channels)[C]>) => Promise<ChannelOutput[C]> | ChannelOutput[C];
};

export function registerIpc(ipc: IpcMainLike, handlers: Handlers, isTrustedSender: (url: string) => boolean, log: ScopedLogger) {
  for (const name of Object.keys(channels) as Channel[]) {
    ipc.handle(name, async (event, raw) => dispatch(name, handlers, raw, event.senderFrame?.url ?? "", isTrustedSender, log));
  }
}

export async function dispatch<C extends Channel>(
  name: C,
  handlers: Handlers,
  raw: unknown,
  senderUrl: string,
  isTrustedSender: (url: string) => boolean,
  log: ScopedLogger,
): Promise<IpcResult<ChannelOutput[C]>> {
  if (!isTrustedSender(senderUrl)) {
    log.warn(`Blocked IPC call to ${name} from untrusted page ${senderUrl || "(unknown)"}`);
    return { ok: false, code: "failed", error: "Not allowed" };
  }
  const parsed = channels[name].safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, code: "invalid-input", error: `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}` };
  }
  try {
    const handler = handlers[name] as (input: unknown) => Promise<ChannelOutput[C]> | ChannelOutput[C];
    return { ok: true, value: await handler(parsed.data) };
  } catch (err) {
    log.error(`IPC ${name} failed`, err);
    return { ok: false, code: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
