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
      'Long-poll for messages directed at your role. Blocks up to 20 seconds then returns. ' +
      'You MUST call this in a continuous loop for the entire session — never stop, even if it returns empty. ' +
      'Pass the `after` message ID from the last response to get only new messages.',
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
    description: 'Get the full session state including phase, plan, joined roles, and all messages.',
    inputSchema: {
      type: 'object',
      properties: {
        codeword: { type: 'string' },
      },
      required: ['codeword'],
    },
  },
  {
    name: 'get_my_plan',
    description:
      'Get the plan section assigned to your role, plus the shared overview. Use this during implementation to re-check what you should be working on.',
    inputSchema: {
      type: 'object',
      properties: {
        codeword: { type: 'string' },
        role: { type: 'string', description: 'Your role label' },
      },
      required: ['codeword', 'role'],
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
  {
    name: 'wait_for_replies',
    description:
      'Send a message to multiple roles and block until all of them have replied (up to 2 minutes). ' +
      'Returns the collected replies. Use this instead of send_message + get_messages when you need input from specific roles before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        codeword: { type: 'string' },
        from: { type: 'string', description: 'Your role label (sender)' },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of role labels to send to and wait for replies from',
        },
        content: { type: 'string', description: 'Message content to send to all listed roles' },
      },
      required: ['codeword', 'from', 'to', 'content'],
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
          if (!a['codeword'] || !a['role'])
            return text('Error: codeword and role are required');
          const result = store.joinSession(a['codeword'], a['role']);
          return text(JSON.stringify(result, null, 2));
        }

        case 'send_message': {
          if (!a['from'] || !a['to'] || !a['content'])
            return text('Error: from, to, and content are required');
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
          if (messages.length === 0) {
            return text('No new messages yet. Call get_messages again to keep waiting.');
          }
          return text(JSON.stringify({ messages }, null, 2));
        }

        case 'get_session_state': {
          const session = store.getByCodeword(a['codeword']);
          if (!session) return text(`Error: session not found: ${a['codeword']}`);
          return text(JSON.stringify(session, null, 2));
        }

        case 'get_my_plan': {
          if (!a['codeword'] || !a['role'])
            return text('Error: codeword and role are required');
          const session = store.getByCodeword(a['codeword']);
          if (!session) return text(`Error: session not found: ${a['codeword']}`);
          const overview = session.plan.overview || '(no overview yet)';
          const roleSection = session.plan.roles[a['role']] || '(no tasks assigned to your role yet)';
          return text(
            `## Overview\n${overview}\n\n## Your tasks (${a['role']})\n${roleSection}`,
          );
        }

        case 'ask_coordinator': {
          if (!a['from'] || !a['question'])
            return text('Error: from and question are required');
          const session = store.getByCodeword(a['codeword']);
          if (!session) return text(`Error: session not found: ${a['codeword']}`);
          const beforeId = session.messages.at(-1)?.id ?? null;
          store.addMessage(session.id, a['from'], 'coordinator', a['question']);

          // Wait for a reply specifically from the coordinator, ignoring other senders
          const deadline = Date.now() + 120_000;
          let afterId = beforeId;
          let reply: { content: string } | undefined;
          while (Date.now() < deadline) {
            const remaining = Math.max(deadline - Date.now(), 1000);
            const replies = await store.waitForMessages(session.id, a['from'], afterId, remaining);
            reply = replies.find((r) => r.from === 'coordinator');
            if (reply) break;
            if (replies.length > 0) afterId = replies[replies.length - 1].id;
            else break; // timeout — no more messages
          }
          return text(reply ? reply.content : '(no reply within 2 minutes)');
        }

        case 'wait_for_replies': {
          const toRoles = (args?.['to'] ?? []) as string[];
          if (!a['from'] || !a['content'] || toRoles.length === 0)
            return text('Error: from, to (array), and content are required');
          const session = store.getByCodeword(a['codeword']);
          if (!session) return text(`Error: session not found: ${a['codeword']}`);

          // Capture timestamp BEFORE sending so fast replies aren't missed
          const sentAt = Date.now();

          // Send the message to each target role
          for (const role of toRoles) {
            store.addMessage(session.id, a['from'], role, a['content']);
          }

          // Wait until all target roles have replied
          const replies = await store.waitForRepliesFrom(
            session.id, a['from'], toRoles, 120_000, sentAt,
          );
          return text(JSON.stringify({ replies }, null, 2));
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
