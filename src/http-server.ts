import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { SessionStore } from './session-store.js';
import type { Phase, Role } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createHttpServer(store: SessionStore): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve coordinator UI and node_modules for Relax.js imports
  app.use(express.static(join(__dirname, '..', 'public')));
  app.use('/node_modules', express.static(join(__dirname, '..', 'node_modules')));

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
    store.addMessage(session.id, from as Role, to as Role | 'all', content);
    res.json({ ok: true });
  });

  // GET /session/:codeword/messages?role=&after=&timeout=
  app.get('/session/:codeword/messages', async (req, res) => {
    const { codeword } = req.params;
    const role = req.query['role'] as string | undefined;
    const after = (req.query['after'] as string) || null;
    const timeout = parseInt((req.query['timeout'] as string) || '20000', 10);

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

  // GET /session/:codeword/state
  app.get('/session/:codeword/state', (req, res) => {
    const { codeword } = req.params;
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    res.json(session);
  });

  // PATCH /session/:codeword/design
  app.patch('/session/:codeword/design', (req, res) => {
    const { codeword } = req.params;
    const { designDoc } = req.body as { designDoc?: string };
    if (designDoc === undefined) {
      res.status(400).json({ error: 'designDoc is required' });
      return;
    }
    const session = store.getByCodeword(codeword);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${codeword}` });
      return;
    }
    store.updateDesignDoc(session.id, designDoc);
    res.json({ ok: true });
  });

  // POST /proxy/claude — server-side proxy to Anthropic API (avoids browser CORS)
  app.post('/proxy/claude', async (req, res) => {
    const { apiKey, ...payload } = req.body as { apiKey: string; [key: string]: unknown };
    if (!apiKey) {
      res.status(400).json({ error: 'apiKey is required' });
      return;
    }
    try {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
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
