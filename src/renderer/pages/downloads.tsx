import { Download, X } from "lucide-react";
import { toast } from "sonner";
import { call } from "../lib/api";
import { formatBytes, formatTime } from "../lib/format";
import { useJobs } from "../lib/store";
import { Badge, Button, Card, EmptyState, PageHeader } from "../components/ui";
import type { Job } from "../../shared/model";

const TONE: Record<Job["status"], "neutral" | "good" | "warn" | "bad" | "accent"> = {
  queued: "neutral",
  running: "accent",
  succeeded: "good",
  failed: "bad",
  cancelled: "neutral",
  interrupted: "warn",
};

export function DownloadsPage() {
  const jobs = useJobs();
  const ordered = [...jobs].reverse();
  return (
    <>
      <PageHeader
        title="Downloads"
        description="Every download and installation task, with its progress and result. Tasks that were running when NexCraft closed are marked interrupted."
        actions={
          <Button onClick={() => void call("jobs:clear-finished", {}).catch((e) => toast.error(e.message))} disabled={!jobs.some(finished)}>
            Clear finished
          </Button>
        }
      />
      <Card>
        {ordered.length === 0 ? (
          <EmptyState icon={<Download className="size-8" />} title="No tasks yet">
            Server files, Java runtimes, mods and modpacks will download here.
          </EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">Task</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Progress</th>
                <th className="pb-2 font-medium">Updated</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ordered.map((job) => (
                <tr key={job.id} className="align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{job.title}</div>
                    {job.error && job.status !== "cancelled" && <div className="mt-0.5 text-xs text-bad">{job.error}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={TONE[job.status]}>{job.status}</Badge>
                  </td>
                  <td className="w-56 py-2 pr-3">
                    <div className="h-1.5 overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={Math.round((job.progress ?? 0) * 100)}>
                      <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      {formatBytes(job.bytesDone)} of {formatBytes(job.bytesTotal)}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted">{formatTime(job.updatedAt)}</td>
                  <td className="py-2 text-right">
                    {(job.status === "queued" || job.status === "running") && (
                      <Button variant="ghost" aria-label={`Cancel ${job.title}`} onClick={() => void call("jobs:cancel", { id: job.id })}>
                        <X className="size-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function finished(j: Job) {
  return j.status !== "queued" && j.status !== "running";
}
