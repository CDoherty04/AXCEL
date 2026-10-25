import { createServer, type Server } from "node:http";
import { createService } from "../bootstrap.js";
import { EventFeed } from "../feed.js";
import { loadQuicknodeEnv } from "../lib/quicknode.js";
import type { CreditService } from "../service.js";
import { HttpError } from "./errors.js";
import { sendError, sendJson } from "./http.js";
import { createRouter } from "./router.js";
import { allRoutes, listRouteCatalog } from "./routes/index.js";

loadQuicknodeEnv();

const HOST = "127.0.0.1";
const PREFERRED_PORT = 3000;
const MAX_PORT = PREFERRED_PORT + 9;

// The credit-layer service bootstraps Devnet in the background; its routes answer 503 until it is ready.
// Credit-layer routes 503 until Devnet bootstrap finishes (faucet, vault, broker).
let creditLayer: CreditService | null = null;
let creditLayerStatus = "starting";
const holder = {
  get(): CreditService {
    if (!creditLayer) throw new HttpError(503, `credit-layer service is ${creditLayerStatus}`, { code: "service_unavailable" });
    return creditLayer;
  },
};

const RECONCILE_EVERY_MS = 60_000;

async function startCreditLayer(): Promise<void> {
  try {
    const wiring = await createService({
      log: (m) => {
        console.log(`[credit-layer] ${m}`);
        const wait = /vault subscription window closes in (\d+)s/.exec(m);
        if (wait) creditLayerStatus = `starting (Devnet vault opens in ${wait[1]}s)`;
      },
    });
    creditLayer = wiring.service;
    creditLayerStatus = "ready";
    await new EventFeed(wiring.service).start();
    // Finish any purchase that stopped part-way (restart, timeout, ledger hiccup).
    setInterval(() => {
      wiring.service.reconcile().then(
        (r) => r.resumed.length && console.log(`[credit-layer] reconciled ${r.resumed.join(", ")}`),
        (e) => console.error("[credit-layer] reconcile failed:", e),
      );
    }, RECONCILE_EVERY_MS).unref();
    console.log("[credit-layer] ready");
  } catch (err) {
    creditLayerStatus = `unavailable (${err instanceof Error ? err.message : String(err)})`;
    console.error("[credit-layer]", creditLayerStatus);
  }
}

const routes = allRoutes(holder);
const catalogRoutes = [
  ...routes,
  {
    method: "GET" as const,
    pattern: "/api/v1",
    handler(ctx: import("./router.js").RouteContext) {
      sendJson(ctx.res, 200, {
        name: "axcel-api",
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
    console.log(`axcel-api listening on ${addr ?? HOST}`);
    return;
  }
  const base = `http://${addr.address}:${addr.port}`;
  console.log(`axcel-api listening on ${base}`);
  console.log(`  axcel catalog`);
  console.log(`  axcel history <account>`);
  console.log(`  axcel score <account>`);
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
  void startCreditLayer();
});
