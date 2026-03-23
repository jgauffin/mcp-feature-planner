import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { SessionStore } from './session-store.js';
import type { CoordinatorRunner, CoordinatorEmitter } from './coordinator.js';
import type { BackendType } from './coordinator/coordinator-backend.js';
import type { Phase, Role } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createHttpServer(store: SessionStore, coordinator: CoordinatorRunner): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve coordinator UI
  app.use(express.static(join(__dirname, '..', 'public')));

  // GET /sessions — list all sessions
  app.get('/sessions', (_req, res) => {
    res.json(store.listSessions());
  });

  // POST /session — create a new session
  app.post('/session', (req, res) => {
    const { feature } = req.body as { feature?: string };
    if (!feature) {
      res.status(400).json({ error: 'feature is required' });
      return;
    }
    const session = store.createSession(feature);
    res.json({ sessionId: session.id, codeword: session.codeword });
  });

  // POST /session/:codeword/join
  app.post('/session/:codeword/join', (req, res) => {
    const { codeword } = req.params;
    const { role } = req.body as { role?: string };
    if (!role) {
      res.status(400).json({ error: 'role is required' });
      return;
    }
    try {
      const result = store.joinSession(codeword, role as Role);
      res.json(result);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // POST /session/:codeword/message
  app.post('/session/:codeword/message', (req, res) => {
    const { codeword } = req.params;
    const { from, to, content } = req.body as { from?: string; to?: string; content?: string };
    if (!from || !to || !content) {
      res.status(400).json({ error: 'from, to, content are required' });
      return;
    }
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    store.addMessage(session.id, from as Role, to as Role, content);
    res.json({ ok: true });
  });

  // GET /session/:codeword/messages?role=&after=&timeout=
  app.get('/session/:codeword/messages', async (req, res) => {
    const { codeword } = req.params;
    const role = req.query['role'] as string | undefined;
    const after = (req.query['after'] as string) || null;
    const timeout = parseInt((req.query['timeout'] as string) || '60000', 10);

    if (!role) {
      res.status(400).json({ error: 'role query param is required' });
      return;
    }

    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    const heartbeat = setInterval(() => {
      try { res.write('\n'); } catch { /* ignore */ }
    }, 5000);

    try {
      const messages = await store.waitForMessages(session.id, role, after, timeout);
      clearInterval(heartbeat);
      res.end(JSON.stringify({ messages }));
    } catch (e) {
      clearInterval(heartbeat);
      res.end(JSON.stringify({ messages: [], error: (e as Error).message }));
    }
  });

  // POST /session/:codeword/wait-for-replies — send to agents and block until they reply
  app.post('/session/:codeword/wait-for-replies', async (req, res) => {
    const { codeword } = req.params;
    const { from, to, content } = req.body as { from?: string; to?: string[]; content?: string };
    if (!from || !to || !Array.isArray(to) || to.length === 0 || !content) {
      res.status(400).json({ error: 'from (string), to (string[]), and content are required' });
      return;
    }
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }

    // Capture timestamp before sending so fast replies aren't missed
    const sentAt = Date.now();
    for (const role of to) {
      store.addMessage(session.id, from as Role, role as Role, content);
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    const heartbeat = setInterval(() => {
      try { res.write('\n'); } catch { /* ignore */ }
    }, 5000);

    try {
      const replies = await store.waitForRepliesFrom(session.id, from as Role, to, 120_000, sentAt);
      clearInterval(heartbeat);
      res.end(JSON.stringify({ replies }));
    } catch (e) {
      clearInterval(heartbeat);
      res.end(JSON.stringify({ replies: [], error: (e as Error).message }));
    }
  });

  // GET /session/:codeword/messages-for — get messages addressed to a role since a timestamp (non-blocking)
  app.get('/session/:codeword/messages-for', (req, res) => {
    const { codeword } = req.params;
    const role = req.query['role'] as string | undefined;
    const since = parseInt((req.query['since'] as string) || '0', 10);
    if (!role) {
      res.status(400).json({ error: 'role query param is required' });
      return;
    }
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    const messages = session.messages.filter(
      (m) => m.to === role && m.timestamp > since,
    );
    res.json({ messages });
  });

  // GET /session/:codeword/state
  app.get('/session/:codeword/state', (req, res) => {
    const { codeword } = req.params;
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    res.json({
      ...session,
      coordinatorRunning: coordinator.isRunning(session.id),
    });
  });

  // PATCH /session/:codeword/plan — update full plan (overview + per-role sections)
  app.patch('/session/:codeword/plan', (req, res) => {
    const { codeword } = req.params;
    const { overview, roles } = req.body as { overview?: string; roles?: Record<string, string> };
    if (overview === undefined && roles === undefined) {
      res.status(400).json({ error: 'overview and/or roles are required' });
      return;
    }
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    store.updatePlan(
      session.id,
      overview ?? session.plan.overview,
      roles ?? session.plan.roles,
    );
    res.json({ ok: true });
  });

  // GET /session/:codeword/plan/:role — get a specific role's plan section + overview
  app.get('/session/:codeword/plan/:role', (req, res) => {
    const { codeword, role } = req.params;
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    res.json({
      overview: session.plan.overview,
      roleSection: session.plan.roles[role] || '',
    });
  });

  // POST /session/:codeword/coordinator/trigger — SSE endpoint for coordinator agent loop
  app.post('/session/:codeword/coordinator/trigger', (req, res) => {
    const { codeword } = req.params;
    const { message, apiKey: providedKey, backend: backendOverride } = req.body as {
      message?: string;
      apiKey?: string;
      backend?: BackendType;
    };

    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }

    const effectiveBackend = backendOverride || 'api';
    const apiKey = providedKey || process.env.ANTHROPIC_API_KEY || '';
    if (effectiveBackend === 'api' && !apiKey) {
      res.status(400).json({ error: 'API key is required (pass apiKey or set ANTHROPIC_API_KEY env var)' });
      return;
    }

    if (coordinator.isRunning(session.id)) {
      res.status(409).json({ error: 'Coordinator is already running for this session' });
      return;
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const emit: CoordinatorEmitter = {
      thinking(label: string) {
        res.write(`event: thinking\ndata: ${JSON.stringify({ label })}\n\n`);
      },
      text(content: string) {
        res.write(`event: text\ndata: ${JSON.stringify({ content })}\n\n`);
      },
      toolStart(tool: string, input: Record<string, unknown>) {
        res.write(`event: tool_start\ndata: ${JSON.stringify({ tool, input })}\n\n`);
      },
      toolResult(tool: string, result: string) {
        res.write(`event: tool_result\ndata: ${JSON.stringify({ tool, result })}\n\n`);
      },
      done() {
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
      },
      error(message: string) {
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      },
    };

    coordinator.trigger(session.id, message || null, apiKey, emit, backendOverride).catch((e) => {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`);
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
      } catch { /* response may already be closed */ }
    });
  });

  // GET /session/:codeword/coordinator/status
  app.get('/session/:codeword/coordinator/status', (req, res) => {
    const { codeword } = req.params;
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    res.json({ isRunning: coordinator.isRunning(session.id) });
  });

  // POST /session/:codeword/coordinator/cancel — abort the running coordinator
  app.post('/session/:codeword/coordinator/cancel', (req, res) => {
    const { codeword } = req.params;
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    const cancelled = coordinator.cancel(session.id);
    // Also clear any pending messages so the coordinator doesn't auto-resume
    const cleared = coordinator.clearPending(session.id);
    res.json({ cancelled, cleared });
  });

  // DELETE /session/:codeword/coordinator/pending — clear queued messages
  app.delete('/session/:codeword/coordinator/pending', (req, res) => {
    const { codeword } = req.params;
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    const cleared = coordinator.clearPending(session.id);
    res.json({ cleared });
  });

  // GET /session/:codeword/coordinator/pending — check pending count
  app.get('/session/:codeword/coordinator/pending', (req, res) => {
    const { codeword } = req.params;
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    res.json({ count: coordinator.pendingCount(session.id) });
  });

  // POST /session/:codeword/phase
  app.post('/session/:codeword/phase', (req, res) => {
    const { codeword } = req.params;
    const { phase } = req.body as { phase?: Phase };
    if (!phase) {
      res.status(400).json({ error: 'phase is required' });
      return;
    }
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    try {
      store.setPhase(session.id, phase);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return app;
}
