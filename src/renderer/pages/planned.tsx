import { NotYetBuilt, PageHeader } from "../components/ui";

export function ModpacksPage() {
  return (
    <>
      <PageHeader title="Modpacks" description="Turn a CurseForge or Modrinth modpack into a working server." />
      <NotYetBuilt milestone="milestone 4">
        <p>Import CurseForge and Modrinth pack files or project links. NexCraft will check the archive, work out the Minecraft version, loader and Java, prefer the official server pack, and leave out client-only mods.</p>
        <p>Mods whose authors do not allow third-party downloads are listed with a link so you can download them yourself.</p>
      </NotYetBuilt>
    </>
  );
}

export function ModsPage() {
  return (
    <>
      <PageHeader title="Mods" description="Add, update, disable and remove mods with dependency checks." />
      <NotYetBuilt milestone="milestone 4">
        <p>Every change is shown before it is applied and can be rolled back. Compatibility is labelled by how sure NexCraft is: confirmed, from metadata, suspected conflict, unknown, or confirmed incompatible.</p>
      </NotYetBuilt>
    </>
  );
}

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
