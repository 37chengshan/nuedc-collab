import { startServer } from "./server.js";

const port = process.env.NUEDC_SERVER_PORT ? Number.parseInt(process.env.NUEDC_SERVER_PORT, 10) : undefined;
const repoRoot = process.env.NUEDC_REPO_ROOT;

const started = await startServer({
  ...(port === undefined ? {} : { port }),
  ...(repoRoot === undefined ? {} : { repoRoot }),
});
process.stdout.write(`NUEDC server listening on http://${started.host}:${started.port}\n`);
