import { NotYetBuilt, PageHeader } from "../components/ui";

export function BackupsPage() {
  return (
    <>
      <PageHeader title="Backups" description="Manual and scheduled backups with safe restore." />
      <NotYetBuilt milestone="milestone 4">
        <p>Backups will save the world first, verify each archive, keep a retention policy that never deletes your only good backup, and preview a restore before it happens.</p>
      </NotYetBuilt>
    </>
  );
}
