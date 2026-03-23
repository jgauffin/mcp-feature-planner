import { query, tool, createSdkMcpServer, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CoordinatorBackend, CoordinatorToolDef } from './coordinator-backend.js';
import type { CoordinatorEmitter } from '../coordinator.js';
import type { SessionStore } from '../session-store.js';
import type { Role } from '../types.js';

/**
 * Build an in-process MCP server exposing the coordinator tools.
 * The tool callbacks have direct access to the SessionStore — no IPC needed.
 */
function createCoordinatorMcpServer(store: SessionStore, sessionId: string, signal?: AbortSignal) {
  let lastCheckTs = 0;

  return createSdkMcpServer({
    name: 'coordinator',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        'Send a one-way message to a specific agent. Use this only for announcements or instructions that do NOT need a response. For messages that need agent input, use wait_for_replies instead.',
        {
          to: z.string().describe('Target role label (e.g. "backend", "frontend"). Must be a specific agent role.'),
          content: z.string().describe('Message content'),
        },
        async (args) => {
          if (!args.to || args.to === 'all') {
            return { content: [{ type: 'text' as const, text: 'Error: you must address a specific agent role, not "all". Use wait_for_replies with an array of roles if you need to reach multiple agents.' }] };
          }
          store.addMessage(sessionId, 'coordinator' as Role, args.to as Role, args.content);
          lastCheckTs = Date.now();
          return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
        },
      ),

      tool(
        'wait_for_replies',
        'Send a message to one or more agents and BLOCK until all of them reply (up to 2 minutes). Returns the collected replies as text. Use this whenever you need agent input before continuing — it keeps the conversation flowing without halting.',
        {
          to: z.array(z.string()).describe('List of target role labels to send to and wait for replies from'),
          content: z.string().describe('Message content to send to all listed roles'),
        },
        async (args) => {
          if (args.to.length === 0) {
            return { content: [{ type: 'text' as const, text: 'Error: to (array of roles) is required' }] };
          }
          const sentAt = Date.now();
          for (const role of args.to) {
            store.addMessage(sessionId, 'coordinator' as Role, role as Role, args.content);
          }
          const replies = await store.waitForRepliesFrom(
            sessionId,
            'coordinator' as Role,
            args.to,
            120_000,
            sentAt,
            signal,
          );
          lastCheckTs = Date.now();
          if (replies.length === 0) {
            return { content: [{ type: 'text' as const, text: '(no replies received within timeout)' }] };
          }
          const text = replies.map((r) => `[${r.from}]: ${r.content}`).join('\n\n---\n\n');
          return { content: [{ type: 'text' as const, text }] };
        },
      ),

      tool(
        'get_new_messages',
        'Check for any new messages from agents since the coordinator last checked. Returns messages addressed to the coordinator. Use this to see if agents have sent anything since your last action.',
        { _unused: z.string().optional().describe('No parameters needed') },
        async () => {
          const session = store.getSession(sessionId);
          const msgs = (session?.messages ?? []).filter(
            (m) => m.to === 'coordinator' && m.from !== 'coordinator' && m.timestamp > lastCheckTs,
          );
          lastCheckTs = Date.now();
          if (msgs.length === 0) {
            return { content: [{ type: 'text' as const, text: '(no new messages from agents)' }] };
          }
          const text = msgs.map((m) => `[${m.from}]: ${m.content}`).join('\n\n---\n\n');
          return { content: [{ type: 'text' as const, text }] };
        },
      ),

      tool(
        'update_plan',
        'Update the implementation plan. Provide an overview (shared context, goals, API contracts) and per-role sections (specific tasks for each agent). Each role gets ONLY their section when implementation starts.',
        {
          overview: z.string().describe('Shared overview: goals, constraints, interfaces, API contracts'),
          roles: z.record(z.string(), z.string()).describe('Per-role plan sections. Keys are role labels, values are markdown task lists for that role.'),
        },
        async (args) => {
          store.updatePlan(sessionId, args.overview, args.roles as Record<string, string>);
          return { content: [{ type: 'text' as const, text: 'Plan updated.' }] };
        },
      ),
    ],
  });
}

const ALLOWED_TOOLS = [
  'mcp__coordinator__send_message',
  'mcp__coordinator__wait_for_replies',
  'mcp__coordinator__get_new_messages',
  'mcp__coordinator__update_plan',
];

/**
 * Coordinator backend powered by the Claude Agent SDK.
 *
 * Uses `query()` with an in-process MCP server for tool execution.
 * Claude Code manages its own session — we only send the latest user
 * message and use `resume` for multi-turn continuity.
 */
export class ClaudeCodeBackend implements CoordinatorBackend {
  /** Maps planner sessionId → Claude Code session ID */
  private sessions = new Map<string, string>();

  constructor(private store: SessionStore) {}

  getClaudeSessionId(plannerSessionId: string): string | undefined {
    return this.sessions.get(plannerSessionId);
  }

  async runLoop(
    systemPrompt: string,
    history: Array<{ role: string; content: unknown }>,
    _tools: CoordinatorToolDef[],
    _executeTool: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<string>,
    emit: CoordinatorEmitter,
    signal: AbortSignal,
    plannerSessionId?: string,
  ): Promise<void> {
    emit.thinking('Claude Code is thinking\u2026');

    const userPrompt = this.extractLatestUserMessage(history);
    if (!userPrompt) {
      emit.error('No user message to send.');
      return;
    }

    const claudeSessionId = plannerSessionId ? this.sessions.get(plannerSessionId) : undefined;
    const mcpServer = createCoordinatorMcpServer(this.store, plannerSessionId!, signal);

    // Wire abort signal
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      // SDK requires async generator for prompt when using MCP servers
      async function* generatePrompt(): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user' as const,
          session_id: '',
          message: { role: 'user' as const, content: userPrompt },
          parent_tool_use_id: null,
        };
      }

      for await (const msg of query({
        prompt: generatePrompt(),
        options: {
          systemPrompt: claudeSessionId ? undefined : systemPrompt +
            '\n\nABSOLUTE CONSTRAINT:\n' +
            'You are a PURE coordinator. You MAY NOT explore the codebase, read files, search code, or investigate anything yourself. ' +
            'You have NO filesystem tools and MUST NOT attempt to use any. ' +
            'All technical knowledge must come from the agents via your MCP messaging tools (wait_for_replies, send_message, get_new_messages). ' +
            'If you need information about the codebase, architecture, or implementation details — ask the relevant agent. ' +
            'Your ONLY job is to coordinate, synthesize, and maintain the plan.',
          resume: claudeSessionId,
          mcpServers: { coordinator: mcpServer },
          allowedTools: ALLOWED_TOOLS,
          abortController: ac,
          permissionMode: 'acceptEdits',
          maxTurns: 20,
        },
      })) {
        // Capture Claude Code session ID for future resume
        if ('session_id' in msg && msg.session_id && plannerSessionId) {
          this.sessions.set(plannerSessionId, msg.session_id);
        }

        switch (msg.type) {
          case 'assistant': {
            const message = (msg as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } }).message;
            if (message?.content) {
              const textParts = message.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('\n\n');

              if (textParts) {
                emit.text(textParts);
                history.push({ role: 'assistant', content: message.content });
              }

              const toolUses = message.content.filter((b) => b.type === 'tool_use');
              for (const t of toolUses) {
                emit.toolStart(t.name!, t.input as Record<string, unknown>);
              }
            }
            break;
          }

          case 'result': {
            // Only emit errors — successful result text is already emitted
            // via the 'assistant' messages above, so re-emitting would
            // cause duplicate messages in the UI.
            const result = msg as { subtype?: string; result?: string };
            if (result.subtype !== 'success' && result.result) {
              emit.error(result.result);
            }
            break;
          }
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        emit.error(`Claude Code error: ${(err as Error).message}`);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Extract only the latest user message from history.
   * Previous messages are already in the Claude Code session.
   */
  private extractLatestUserMessage(
    history: Array<{ role: string; content: unknown }>,
  ): string {
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.role !== 'user') continue;

      if (typeof entry.content === 'string') {
        return entry.content;
      }
      if (Array.isArray(entry.content)) {
        const parts: string[] = [];
        for (const block of entry.content as Array<Record<string, unknown>>) {
          if (typeof block.text === 'string') parts.push(block.text);
          else if (block.type === 'tool_result' && typeof block.content === 'string') {
            parts.push(block.content);
          }
        }
        if (parts.length) return parts.join('\n\n');
      }
    }
    return '';
  }
}
