import { SessionStore } from './session-store.js';
import { createHttpServer } from './http-server.js';
import { mountMcpServer } from './mcp-server.js';
import { CoordinatorRunner } from './coordinator.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const store = new SessionStore();
const coordinator = new CoordinatorRunner(store);

const app = createHttpServer(store, coordinator);

// Mount MCP server on the same Express app (Streamable HTTP at /mcp)
mountMcpServer(app, store);

app.listen(PORT, () => {
  console.log(`Feature Planner running on http://localhost:${PORT}`);
  console.log(`  UI:  http://localhost:${PORT}`);
  console.log(`  MCP: http://localhost:${PORT}/mcp`);
});
