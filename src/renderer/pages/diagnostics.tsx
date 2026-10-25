import { useMemo, useState } from "react";
import { call } from "../lib/api";
import { useLogs } from "../lib/store";
import { Button, Card, PageHeader } from "../components/ui";
import { cn } from "../lib/format";
import type { LogLevel } from "../../shared/ipc";

const LEVEL_STYLE: Record<LogLevel, string> = { debug: "text-muted", info: "text-text", warn: "text-warn", error: "text-bad" };

export function DiagnosticsPage() {
  const logs = useLogs(1000);
  const [query, setQuery] = useState("");
  const [minLevel, setMinLevel] = useState<LogLevel>("info");
  const order: LogLevel[] = ["debug", "info", "warn", "error"];
  const shown = useMemo(
    () =>
      logs.filter(
        (l) => order.indexOf(l.level) >= order.indexOf(minLevel) && (!query || `${l.scope} ${l.message}`.toLowerCase().includes(query.toLowerCase())),
      ),
    [logs, query, minLevel],
  );

  return (
    <>
      <PageHeader
        title="Diagnostics"
        description="NexCraft's own activity log. Secrets such as API keys and RCON passwords are removed before anything is written. Server crash analysis arrives with the server console."
        actions={<Button onClick={() => void call("shell:open-folder", { which: "logs" })}>Open logs folder</Button>}
      />
      <Card>
        <div className="mb-3 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter messages"
            aria-label="Filter messages"
            className="w-72 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <select
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as LogLevel)}
            aria-label="Minimum level"
            className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm"
          >
            {order.map((l) => (
              <option key={l} value={l}>
                {l} and above
              </option>
            ))}
          </select>
        </div>
        <div className="h-[60vh] overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-xs leading-5">
          {shown.length === 0 ? (
            <p className="text-muted">No log entries match.</p>
          ) : (
            shown.map((l, i) => (
              <div key={i} className={cn("whitespace-pre-wrap", LEVEL_STYLE[l.level])}>
                <span className="text-muted">{l.at.slice(11, 19)}</span> [{l.scope}] {l.message}
              </div>
            ))
          )}
        </div>
      </Card>
    </>
  );
}
