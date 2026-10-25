import type { Channel, ChannelInput, ChannelOutput, EventName, EventPayload, NexcraftBridge } from "../../shared/ipc";

declare global {
  interface Window {
    nexcraft?: NexcraftBridge;
  }
}

export class ApiError extends Error {}

function bridge(): NexcraftBridge {
  if (!window.nexcraft) throw new ApiError("NexCraft's desktop bridge is missing. Start NexCraft from NexCraft.exe.");
  return window.nexcraft;
}

/** Call the main process; throws ApiError with a readable message on failure. */
export async function call<C extends Channel>(channel: C, input: ChannelInput<C>): Promise<ChannelOutput[C]> {
  const result = await bridge().invoke(channel, input);
  if (!result.ok) throw new ApiError(result.error);
  return result.value;
}

export function subscribe<E extends EventName>(event: E, listener: (payload: EventPayload[E]) => void) {
  return bridge().on(event, listener);
}

export function hasBridge() {
  return Boolean(window.nexcraft);
}
