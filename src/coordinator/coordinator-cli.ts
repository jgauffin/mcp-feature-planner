#!/usr/bin/env node

/**
 * Standalone coordinator script.
 *
 * Runs the coordinator as a separate process that connects to the
 * Feature Planner server via HTTP. Supports choosing between backends.
 *
 * Usage:
 *   node dist/coordinator-cli.js --codeword <codeword> [--backend api|claude-code] [--server http://localhost:3000]
 *
 * Environment:
 *   ANTHROPIC_API_KEY  — required for the 'api' backend
 *   PLANNER_SERVER     — server URL (default: http://localhost:3000)
 */

import { ProxyAgent } from 'undici';
import type { BackendType, CoordinatorToolDef } from './coordinator-backend.js';
import type { CoordinatorEmitter } from '../coordinator.js';
import { COORDINATOR_TOOLS } from '../coordinator.js';
import { AnthropicApiBackend } from './coordinator-api-backend.js';
import { ClaudeCodeBackend } from './coordinator-claudecode-backend.js';
import { SessionStore } from '../session-store.js';
import type { Session, Message, Role } from '../types.js';

// ── CLI argument parsing ────────────────────────────────────────

function parseArgs(): { codeword: string; backend: BackendType; serverUrl: string } {
  const args = process.argv.slice(2);
  let codeword = '';
  let backend: BackendType = 'api';
  let serverUrl = process.env['PLANNER_SERVER'] || 'http://localhost:3000';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--codeword':
      case '-c':
        codeword = args[++i] || '';
        break;
      case '--backend':
      case '-b':
        backend = (args[++i] || 'api') as BackendType;
        break;
      case '--server':
      case '-s':
        serverUrl = args[++i] || serverUrl;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }

  if (!codeword) {
    console.error('Error: --codeword is required\n');
    printUsage();
    process.exit(1);
  }

  if (!['api', 'claude-code'].includes(backend)) {
    console.error(`Error: unknown backend "${backend}". Use "api" or "claude-code".\n`);
    process.exit(1);
  }

  return { codeword, backend, serverUrl };
}

function printUsage(): void {
  console.log(`
Feature Planner — Standalone Coordinator

Usage:
  node dist/coordinator-cli.js --codeword <codeword> [options]

Options:
  -c, --codeword <word>    Session codeword (required)
  -b, --backend <type>     Backend: "api" (default) or "claude-code"
  -s, --server <url>       Server URL (default: http://localhost:3000 or PLANNER_SERVER env)
  -h, --help               Show this help

Environment:
  ANTHROPIC_API_KEY        Required for the "api" backend
  PLANNER_SERVER           Default server URL
  `.trim());
}

// ── HTTP client for the Feature Planner server ──────────────────

class PlannerClient {
  private proxyAgent: ProxyAgent | undefined;

  constructor(private serverUrl: string) {
    const proxyUrl =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy;
    if (proxyUrl) {
      this.proxyAgent = new ProxyAgent(proxyUrl);
    }
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const opts: Record<string, unknown> = { ...init };
    if (this.proxyAgent) {
      opts.dispatcher = this.proxyAgent;
    }
    return fetch(`${this.serverUrl}${path}`, opts as RequestInit);
  }

  async getSession(codeword: string): Promise<Session> {
    const res = await this.fetch(`/session/${codeword}/state`);
    if (!res.ok) throw new Error(`Failed to get session: ${res.statusText}`);
    return (await res.json()) as Session;
  }

  async addMessage(codeword: string, from: string, to: string, content: string): Promise<void> {
    const res = await this.fetch(`/session/${codeword}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, content }),
    });
    if (!res.ok) throw new Error(`Failed to send message: ${res.statusText}`);
  }

  async waitForReplies(
    codeword: string,
    from: string,
    to: string[],
    content: string,
  ): Promise<Message[]> {
    const res = await this.fetch(`/session/${codeword}/wait-for-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, content }),
    });
    if (!res.ok) throw new Error(`Failed to wait for replies: ${res.statusText}`);
    const data = (await res.json()) as { replies: Message[] };
    return data.replies;
  }

  async getMessagesFor(codeword: string, role: string, since: number): Promise<Message[]> {
    const res = await this.fetch(
      `/session/${codeword}/messages-for?role=${encodeURIComponent(role)}&since=${since}`,
    );
    if (!res.ok) throw new Error(`Failed to get messages: ${res.statusText}`);
    const data = (await res.json()) as { messages: Message[] };
    return data.messages;
  }

  async updatePlan(
    codeword: string,
    overview: string,
    roles: Record<string, string>,
  ): Promise<void> {
    const res = await this.fetch(`/session/${codeword}/plan`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overview, roles }),
    });
    if (!res.ok) throw new Error(`Failed to update plan: ${res.statusText}`);
  }
}

// ── Coordinator loop ────────────────────────────────────────────

function buildSystemPrompt(session: Session): string {
  const agentRoles = session.joinedRoles.filter((r: string) => r !== 'coordinator');
  const planSummary = session.plan
    ? `Overview: ${session.plan.overview || '(empty)'}\n` +
      agentRoles.map((r: string) => `${r}: ${session.plan.roles?.[r] || '(empty)'}`).join('\n')
    : '(no plan yet)';

  return (
    'You are a technical planning coordinator facilitating a design session ' +
    'between one or more developer agents.\n\n' +
    'Your responsibilities:\n' +
    '- Ask each agent TARGETED questions about their specific domain\n' +
    '- Identify interfaces between roles (API contracts, shared state, events)\n' +
    '- Synthesize into a STRUCTURED PLAN via update_plan\n' +
    '- Flag unresolved questions back to the human\n' +
    '- Be succinct and to the point\n\n' +
    'CRITICAL communication rules:\n' +
    '- Use wait_for_replies (NOT send_message) when you need agent input\n' +
    '- Use send_message ONLY for one-way announcements\n' +
    '- Always address SPECIFIC agents by role name\n\n' +
    `Feature: ${session.feature ?? ''}\n` +
    `Joined agents: ${agentRoles.join(', ') || 'none yet'}\n\n` +
    `Current plan:\n${planSummary}`
  );
}

async function runCoordinator(
  codeword: string,
  backendType: BackendType,
  client: PlannerClient,
): Promise<void> {
  const session = await client.getSession(codeword);
  console.log(`Connected to session "${codeword}" — feature: ${session.feature}`);
  console.log(`Joined roles: ${session.joinedRoles.join(', ')}`);
  console.log(`Backend: ${backendType}\n`);

  const apiKey = process.env['ANTHROPIC_API_KEY'] || '';
  if (backendType === 'api' && !apiKey) {
    console.error('Error: ANTHROPIC_API_KEY is required for the "api" backend.');
    process.exit(1);
  }

  const backend =
    backendType === 'claude-code'
      ? new ClaudeCodeBackend(new SessionStore())
      : new AnthropicApiBackend(apiKey);

  const history: Array<{ role: string; content: unknown }> = [];
  const systemPrompt = buildSystemPrompt(session);
  let lastCheckTs = 0;

  const ac = new AbortController();
  process.on('SIGINT', () => {
    console.log('\nCancelling coordinator...');
    ac.abort();
  });

  const emit: CoordinatorEmitter = {
    thinking(label) {
      process.stdout.write(`\r\x1b[K\x1b[2m${label}\x1b[0m`);
    },
    text(content) {
      process.stdout.write(`\n\x1b[1mCoordinator:\x1b[0m ${content}\n`);
      // Also persist to server
      client.addMessage(codeword, 'coordinator', '[user]', content).catch(() => {});
    },
    toolStart(tool, input) {
      const summary = JSON.stringify(input).slice(0, 100);
      process.stdout.write(`\n\x1b[33m→ ${tool}\x1b[0m ${summary}\n`);
    },
    toolResult(tool, result) {
      const preview = result.slice(0, 200);
      process.stdout.write(`\x1b[32m← ${tool}\x1b[0m ${preview}\n`);
    },
    done() {
      process.stdout.write('\n\x1b[2mCoordinator turn complete.\x1b[0m\n');
    },
    error(message) {
      process.stderr.write(`\n\x1b[31mError:\x1b[0m ${message}\n`);
    },
  };

  const executeTool = async (
    name: string,
    input: Record<string, unknown>,
    _signal: AbortSignal,
  ): Promise<string> => {
    switch (name) {
      case 'send_message': {
        const to = input.to as string;
        const content = input.content as string;
        await client.addMessage(codeword, 'coordinator', to, content);
        lastCheckTs = Date.now();
        return 'Message sent.';
      }

      case 'wait_for_replies': {
        const toRoles = (input.to as string[]) || [];
        const content = input.content as string;
        const replies = await client.waitForReplies(codeword, 'coordinator', toRoles, content);
        lastCheckTs = Date.now();
        if (replies.length === 0) return '(no replies received within timeout)';
        return replies.map((r) => `[${r.from}]: ${r.content}`).join('\n\n---\n\n');
      }

      case 'get_new_messages': {
        const msgs = await client.getMessagesFor(codeword, 'coordinator', lastCheckTs);
        lastCheckTs = Date.now();
        const filtered = msgs.filter((m) => m.from !== 'coordinator');
        if (filtered.length === 0) return '(no new messages from agents)';
        return filtered.map((m) => `[${m.from}]: ${m.content}`).join('\n\n---\n\n');
      }

      case 'update_plan': {
        const overview = (input.overview as string) ?? '';
        const roles = (input.roles as Record<string, string>) ?? {};
        await client.updatePlan(codeword, overview, roles);
        return 'Plan updated.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  };

  // Interactive loop: read user input, run coordinator turn
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question('\n\x1b[1mYou:\x1b[0m ', async (text) => {
      if (!text.trim()) {
        prompt();
        return;
      }

      if (text.trim() === '/quit' || text.trim() === '/exit') {
        console.log('Goodbye.');
        rl.close();
        process.exit(0);
      }

      history.push({ role: 'user', content: text });

      try {
        await backend.runLoop(systemPrompt, history, COORDINATOR_TOOLS, executeTool, emit, ac.signal);
      } catch (e) {
        emit.error((e as Error).message);
      }

      prompt();
    });
  };

  console.log('Coordinator ready. Type a message to start planning.');
  console.log('Commands: /quit to exit\n');

  // Check for any existing messages from agents
  const existingMsgs = await client.getMessagesFor(codeword, 'coordinator', 0);
  const agentMsgs = existingMsgs.filter((m) => m.from !== 'coordinator' && m.from !== '[user]');
  if (agentMsgs.length > 0) {
    console.log(`Found ${agentMsgs.length} existing message(s) from agents.`);
  }

  prompt();
}

// ── Entry point ─────────────────────────────────────────────────

const { codeword, backend, serverUrl } = parseArgs();
const client = new PlannerClient(serverUrl);

runCoordinator(codeword, backend, client).catch((e) => {
  console.error('Fatal error:', (e as Error).message);
  process.exit(1);
});
