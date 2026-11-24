// A stand-in for the mock, the app or the worker, so the launcher can be tested without Next or Bun.
// usage: node fake-child.mjs <mock|app|worker> <port|-> ; FAKE_LOG names a file that records every start.
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";

const [kind, port] = process.argv.slice(2);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${kind} ${process.pid}\n`);
if (kind === "worker") {
  // A worker.ts that is still being written (marked PARTIAL) makes the real worker fail on start; the fake does the same.
  try {
    if (readFileSync("src/noblecloak/worker.ts", "utf8").includes("PARTIAL")) process.exit(1);
  } catch { process.exit(1); }
  // What the real worker would read at start: the agent id in agent.json.
  try {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `workerSawAgentId ${JSON.parse(readFileSync("src/noblecloak/agent.json", "utf8")).id}\n`);
  } catch { /* no agent.json */ }
  // FAKE_WORKER_DELAY_MS keeps the launcher busy starting the worker, as a real worker's boot does.
  setTimeout(() => console.log("worker_ready"), Number(process.env.FAKE_WORKER_DELAY_MS ?? 0));
  setInterval(() => undefined, 1000);
} else {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/proposal") return res.end(JSON.stringify({ reachable: true, proposal: { id: "p1", actionDigest: "digest-1", state: "pending" } }));
      if (req.url === "/api/proposal/p1/approve") {
        if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `approve ${JSON.parse(body).expectedActionDigest}\n`);
        return res.end(JSON.stringify({ ok: true }));
      }
      res.end(JSON.stringify({ state: "idle", audience: `http://127.0.0.1:${port}`, admin: "x", creator_user: "creator-token" }));
    });
  });
  server.listen(Number(port), "127.0.0.1", () => console.log(`${kind} listening on ${port}`));
}
process.on("SIGTERM", () => process.exit(0));
