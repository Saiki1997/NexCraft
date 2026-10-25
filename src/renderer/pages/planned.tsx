import { NotYetBuilt, PageHeader } from "../components/ui";

export function ServersPage() {
  return (
    <>
      <PageHeader title="Servers" description="Start, stop, restart and manage each server, with its live console." />
      <NotYetBuilt milestone="milestone 3">
        <p>This screen will list every server with its status, players, CPU, memory, uptime and last backup, plus start, graceful stop, restart and console.</p>
        <p>The process manager behind it (graceful stop over the server console, force stop only after you confirm) is already part of this build.</p>
      </NotYetBuilt>
    </>
  );
}

export function CreateServerPage() {
  return (
    <>
      <PageHeader title="Create server" description="A guided wizard for a new server." />
      <NotYetBuilt milestone="milestone 3">
        <p>Pick a Minecraft version and server type, name the server and world, and set players, port, game rules, view distance and memory.</p>
        <p>NexCraft will download the official server files, pick or install the right Java, show progress for every step, and ask you to accept the Minecraft EULA yourself before the first start.</p>
      </NotYetBuilt>
    </>
  );
}

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
