import { createServer, type Server } from "node:http";
import { loadQuicknodeEnv } from "../lib/quicknode.js";
import { sendError, sendJson } from "./http.js";
import { createRouter } from "./router.js";
import { allRoutes, listRouteCatalog } from "./routes/index.js";

loadQuicknodeEnv();

const HOST = "127.0.0.1";
const PREFERRED_PORT = 3000;
const MAX_PORT = PREFERRED_PORT + 9;

const routes = allRoutes();
const catalogRoutes = [
  ...routes,
  {
    method: "GET" as const,
    pattern: "/api/v1",
    handler(ctx: import("./router.js").RouteContext) {
      sendJson(ctx.res, 200, {
        name: "bec-api",
        version: "0.1.0",
        routes: listRouteCatalog(routes),
      });
    },
  },
];

const router = createRouter(catalogRoutes);

const server = createServer((req, res) => {
  router.handle(req, res).catch((err) => sendError(res, err));
});

function logListening(server: Server): void {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    console.log(`bec-api listening on ${addr ?? HOST}`);
    return;
  }
  const base = `http://${addr.address}:${addr.port}`;
  console.log(`bec-api listening on ${base}`);
  console.log(`  GET ${base}/api/v1`);
  console.log(`  GET ${base}/api/v1/credit-history/:account?limit=50`);
}

let port = PREFERRED_PORT;

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && port < MAX_PORT) {
    port += 1;
    server.listen(port, HOST);
    return;
  }
  if (err.code === "EADDRINUSE") {
    console.error(
      `No free port in range ${PREFERRED_PORT}–${MAX_PORT}. Stop other listeners (lsof -i :${PREFERRED_PORT}).`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(port, HOST, () => {
  if (port !== PREFERRED_PORT) {
    console.log(`Port ${PREFERRED_PORT} in use; using ${port} instead.`);
  }
  logListening(server);
});
