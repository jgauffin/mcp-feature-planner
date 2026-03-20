import { randomUUID } from 'crypto';
import type { Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { SessionStore } from './session-store.js';

const TOOL_DEFINITIONS = [
  {
    name: 'join_session',
    description:
      'Join a Feature Planner session using its codeword. Supply your role label (free-form: "backend", "frontend", "mobile", etc.). Returns planning instructions and the current roster of joined roles.',
    inputSchema: {
      type: 'object',
      properties: {
        codeword: { type: 'string', description: 'Session codeword (e.g. "swift-falcon")' },
        role: { type: 'string', description: 'Your role label (e.g. "backend", "frontend-react")' },
      },
      required: ['codeword', 'role'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to another role or to all participants in the session.',
    inputSchema: {
      type: 'object',
      properties: {
        codeword: { type: 'string' },
        from: { type: 'string', description: 'Your role label' },
        to: { type: 'string', description: 'Target role label or "all"' },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['codeword', 'from', 'to', 'content'],
    },
  },
  {
    name: 'get_messages',
    description:
      'Long-poll for messages directed at your role. Blocks up to 20 seconds then returns. Pass the `after` message ID from the last call to get only new messages. Call this in a loop to stay up to date.',
    inputSchema: {
      type: 'object',
      properties: {
        codeword: { type: 'string' },
        role: { type: 'string', description: 'Your role label' },
        after: {
          type: 'string',
          description: 'ID of the last message you received. Omit on first call.',
        },
      },
      required: ['codeword', 'role'],
    },
  },
  {
    name: 'get_session_state',
    description: 'Get the full session state including phase, design doc, joined roles, and all messages.',
    inputSchema: {
      type: 'object',
      properties: {
        codeword: { type: 'string' },
      },
      required: ['codeword'],
    },
  },
  {
    name: 'ask_coordinator',
    description:
      'Send a question directly to the coordinator and block until they respond (up to 2 minutes). Use this when you need clarification or a decision before proceeding.',
    inputSchema: {
      type: 'object',
      properties: {
        codeword: { type: 'string' },
        from: { type: 'string', description: 'Your role label' },
        question: { type: 'string', description: 'Your question or request for the coordinator' },
      },
      required: ['codeword', 'from', 'question'],
    },
  },
];

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

export function createMcpServer(store: SessionStore): McpServer {
  const server = new McpServer(
    { name: 'feature-planner', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Feature Planner coordination server. Use join_session(codeword, role) to join a session, ' +
        'then call get_messages in a loop. Use ask_coordinator to block on a question.',
    },
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, string>;

    try {
      switch (name) {
        case 'join_session': {
          const result = store.joinSession(a['codeword'], a['role']);
          return text(JSON.stringify(result, null, 2));
        }

        case 'send_message': {
          const session = store.getByCodeword(a['codeword']);
          if (!session) return text(`Error: session not found: ${a['codeword']}`);
          store.addMessage(session.id, a['from'], a['to'], a['content']);
          return text(JSON.stringify({ ok: true }));
        }

        case 'get_messages': {
          const session = store.getByCodeword(a['codeword']);
          if (!session) return text(`Error: session not found: ${a['codeword']}`);
          const after = a['after'] ?? null;
          const messages = await store.waitForMessages(session.id, a['role'], after, 20_000);
          return text(JSON.stringify({ messages }, null, 2));
        }

        case 'get_session_state': {
          const session = store.getByCodeword(a['codeword']);
          if (!session) return text(`Error: session not found: ${a['codeword']}`);
          return text(JSON.stringify(session, null, 2));
        }

        case 'ask_coordinator': {
          const session = store.getByCodeword(a['codeword']);
          if (!session) return text(`Error: session not found: ${a['codeword']}`);
          const beforeId = session.messages.at(-1)?.id ?? null;
          store.addMessage(session.id, a['from'], 'coordinator', a['question']);
          const replies = await store.waitForMessages(session.id, a['from'], beforeId, 120_000);
          const reply = replies[0];
          return text(reply ? reply.content : '(no reply within 2 minutes)');
        }

        default:
          return text(`Error: unknown tool: ${name}`);
      }
    } catch (e) {
      return text(`Error: ${(e as Error).message}`);
    }
  });

  return server;
}

/**
 * Mount the MCP server on an Express app at /mcp.
 * Each client session gets its own transport; all share the same SessionStore.
 */
export function mountMcpServer(app: Express, store: SessionStore): void {
  // Track transports by session so we can route follow-up requests
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    // Check for existing session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — create a fresh transport + server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });

    // Wire up cleanup
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    const server = createMcpServer(store);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET /mcp — SSE stream for server-to-client notifications
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Missing or invalid mcp-session-id header' });
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
  });

  // DELETE /mcp — client closing its session
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Missing or invalid mcp-session-id header' });
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
  });
}
