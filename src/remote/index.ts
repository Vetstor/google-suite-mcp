import "dotenv/config";
import { loadConfig } from "./config.js";
import { createStore } from "./store.js";
import { createApp } from "./server.js";
import { logger } from "./logger.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`\nFatal: ${(err as Error).message}\n\n`);
    process.exit(1);
  }

  const store = await createStore({
    store: config.store,
    firestoreDatabase: config.firestoreDatabase,
  });

  const app = createApp({ config, store, logger });

  app.listen(config.port, () => {
    logger.info(
      { event: "listening", port: config.port, baseUrl: config.baseUrl, store: config.store },
      `sheets-mcp remote server listening on :${config.port}`
    );
  });
}

main().catch((err) => {
  process.stderr.write(`\nFatal: ${(err as Error).stack ?? err}\n\n`);
  process.exit(1);
});
