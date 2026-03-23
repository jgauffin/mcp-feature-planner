import { SessionStore } from './session-store.js';
import { createHttpServer } from './http-server.js';
import { mountMcpServer } from './mcp-server.js';
import { CoordinatorRunner } from './coordinator.js';
import type { BackendType } from './coordinator/coordinator-backend.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const BACKEND = (process.env['COORDINATOR_BACKEND'] ?? 'api') as BackendType;

const store = new SessionStore();
const coordinator = new CoordinatorRunner(store, BACKEND);

const app = createHttpServer(store, coordinator);

// Mount MCP server on the same Express app (Streamable HTTP at /mcp)
mountMcpServer(app, store);

app.listen(PORT, () => {
  console.log(`Feature Planner running on http://localhost:${PORT}`);
  console.log(`  UI:  http://localhost:${PORT}`);
  console.log(`  MCP: http://localhost:${PORT}/mcp`);
  console.log(`  Coordinator backend: ${BACKEND}`);
});
