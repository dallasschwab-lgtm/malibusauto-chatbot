import { createServer } from "./server.js";
import { logger } from "./lib/logger.js";

// Default to 3000; honour PORT when the runtime injects it (e.g. production).
const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  logger.error({ rawPort }, "Invalid PORT value");
  process.exit(1);
}

const server = createServer();

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
