#!/usr/bin/env node
import { parseArgs, printUsage } from "../src/config.js";
import { createBridgeServer } from "../src/server.js";
import { generatePairingCode } from "../src/security.js";

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${msg}`);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`fleetview-bridge: ${err.message}\n`);
  printUsage();
  process.exit(1);
}

const { repos, port, allowedOrigin } = args;
const { server, setPairingCode } = createBridgeServer({ repos, allowedOrigin, log });

server.listen(port, "127.0.0.1", () => {
  const code = generatePairingCode();
  setPairingCode(code);
  console.log("");
  console.log("  FleetView Bridge — listening on 127.0.0.1 only, not reachable from the network");
  console.log("");
  console.log(`  Repos allowed:  ${repos.join(", ")}`);
  console.log(`  Pairing code:   ${code}`);
  console.log("");
  console.log("  In FleetView → Installation → Local agent, paste the code above.");
  console.log("  This code is one-time and only works while this process keeps running.");
  console.log("");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`fleetview-bridge: port ${port} is already in use — pass --port to use a different one.`);
  } else {
    console.error(`fleetview-bridge: ${err.message}`);
  }
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("Shutting down.");
    server.close(() => process.exit(0));
  });
}
