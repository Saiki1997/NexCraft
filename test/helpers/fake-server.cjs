// A stand-in for a Minecraft server: prints startup lines, echoes commands,
// and exits cleanly on "stop" unless started with --ignore-stop.
const ignoreStop = process.argv.includes("--ignore-stop");
process.stdout.write("[Server thread/INFO]: Starting minecraft server version test\n");
process.stdout.write("partial line without newline then ");
setTimeout(() => process.stdout.write("its end\n"), 20);
process.stderr.write("a warning on stderr\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    process.stdout.write(`> ${line}\n`);
    if (line === "stop" && !ignoreStop) {
      process.stdout.write("Saving worlds\n");
      setTimeout(() => process.exit(0), 50);
    }
  }
});
setInterval(() => {}, 1000);
