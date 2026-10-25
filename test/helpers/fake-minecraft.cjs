// A stand-in for a vanilla Minecraft server JAR, driven over stdin like the real one.
// It prints the lines NexCraft watches for: the "Done" ready line, joins, leaves and stop.
const args = process.argv.slice(2);
const log = (msg) => process.stdout.write(`[12:00:00] [Server thread/INFO]: ${msg}\n`);
log(`Starting minecraft server version fake (args: ${args.join(" ")})`);
setTimeout(() => log('Done (1.234s)! For help, type "help"'), 30);
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    const [cmd, ...rest] = line.split(" ");
    if (cmd === "stop") {
      log("Stopping the server");
      setTimeout(() => process.exit(0), 30);
    } else if (cmd === "join") log(`${rest[0]} joined the game`);
    else if (cmd === "leave") log(`${rest[0]} left the game`);
    else if (cmd === "crash") process.exit(1);
    else if (cmd === "oom") process.stderr.write("java.lang.OutOfMemoryError: Java heap space\n");
    else log(`Unknown command: ${line}`);
  }
});
setInterval(() => {}, 1000);
