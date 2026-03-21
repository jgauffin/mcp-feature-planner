import { ProxyAgent } from 'undici';
import type { SessionStore } from './session-store.js';
import type { Role, Session } from './types.js';

export interface CoordinatorEmitter {
  thinking(label: string): void;
  text(content: string): void;
  toolStart(tool: string, input: Record<string, unknown>): void;
  toolResult(tool: string, result: string): void;
  done(): void;
  error(message: string): void;
}

const COORDINATOR_TOOLS = [
  {
    name: 'send_message',
    description:
      'Send a one-way message to a specific agent. Use this only for announcements or instructions that do NOT need a response. For messages that need agent input, use wait_for_replies instead.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'Target role label (e.g. "backend", "frontend"). Must be a specific agent role.',
        },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'wait_for_replies',
    description:
      'Send a message to one or more agents and BLOCK until all of them reply (up to 2 minutes). Returns the collected replies as text. Use this whenever you need agent input before continuing — it keeps the conversation flowing without halting.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of target role labels to send to and wait for replies from',
        },
        content: { type: 'string', description: 'Message content to send to all listed roles' },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'get_new_messages',
    description:
      'Check for any new messages from agents since the coordinator last checked. Returns messages addressed to the coordinator. Use this to see if agents have sent anything since your last action.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'update_plan',
    description:
      'Update the implementation plan. Provide an overview (shared context, goals, API contracts) and per-role sections (specific tasks for each agent). Each role gets ONLY their section when implementation starts.',
    input_schema: {
      type: 'object',
      properties: {
        overview: {
          type: 'string',
          description: 'Shared overview: goals, constraints, interfaces, API contracts',
        },
        roles: {
          type: 'object',
          description:
            'Per-role plan sections. Keys are role labels, values are markdown task lists for that role.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['overview', 'roles'],
    },
  },
];

export class CoordinatorRunner {
  private histories = new Map<string, Array<{ role: string; content: unknown }>>();
  private pendingMessages = new Map<string, string[]>();
  private lastCheckTs = new Map<string, number>();
  private running = new Map<string, boolean>();

  constructor(private store: SessionStore) {}

  isRunning(sessionId: string): boolean {
    return this.running.get(sessionId) === true;
  }

  async trigger(
    sessionId: string,
    userMessage: string | null,
    apiKey: string,
    emit: CoordinatorEmitter,
  ): Promise<void> {
    if (this.running.get(sessionId)) {
      emit.error('Coordinator is already running for this session.');
      return;
    }

    this.running.set(sessionId, true);

    try {
      const session = this.store.getSession(sessionId);
      if (!session) {
        emit.error('Session not found.');
        return;
      }

      const history = this.histories.get(sessionId) ?? [];

      if (userMessage) {
        history.push({ role: 'user', content: userMessage });
      }

      // Drain any messages that were queued while the coordinator was running
      this.drainPendingMessages(sessionId, history);

      this.histories.set(sessionId, history);

      await this.runLoop(sessionId, session, apiKey, history, emit);
    } finally {
      this.running.set(sessionId, false);
      emit.done();
    }
  }

  /**
   * Queue a user message and trigger the coordinator.
   * If the coordinator is already running, the message is queued safely
   * (separate from the active history) and will be drained on next trigger.
   */
  queueAndTrigger(
    sessionId: string,
    userMessage: string,
    apiKey: string,
    emit: CoordinatorEmitter,
  ): void {
    if (this.running.get(sessionId)) {
      // Queue separately — never mutate the live history during a run
      const pending = this.pendingMessages.get(sessionId) ?? [];
      pending.push(userMessage);
      this.pendingMessages.set(sessionId, pending);
      return;
    }

    this.trigger(sessionId, userMessage, apiKey, emit);
  }

  clearPending(sessionId: string): number {
    const pending = this.pendingMessages.get(sessionId);
    const count = pending?.length ?? 0;
    this.pendingMessages.delete(sessionId);
    return count;
  }

  pendingCount(sessionId: string): number {
    return this.pendingMessages.get(sessionId)?.length ?? 0;
  }

  private drainPendingMessages(
    sessionId: string,
    history: Array<{ role: string; content: unknown }>,
  ): void {
    const pending = this.pendingMessages.get(sessionId);
    if (!pending || pending.length === 0) return;
    for (const msg of pending) {
      history.push({ role: 'user', content: msg });
    }
    this.pendingMessages.delete(sessionId);
  }

  private buildSystemPrompt(session: Session): string {
    const agentRoles = session.joinedRoles.filter((r) => r !== 'coordinator');
    const planSummary = session.plan
      ? `Overview: ${session.plan.overview || '(empty)'}\n` +
        agentRoles.map((r) => `${r}: ${session.plan.roles?.[r] || '(empty)'}`).join('\n')
      : '(no plan yet)';

    return (
      'You are a technical planning coordinator facilitating a design session ' +
      'between one or more developer agents.\n\n' +
      'Your responsibilities:\n' +
      '- Ask each agent TARGETED questions about their specific domain\n' +
      '- Identify interfaces between roles (API contracts, shared state, events)\n' +
      '- Synthesize into a STRUCTURED PLAN via update_plan with:\n' +
      '  - overview: shared context (goals, constraints, API contracts between roles)\n' +
      '  - roles: per-role task lists (each agent only sees their own section + overview)\n' +
      '- Flag unresolved questions back to the human\n' +
      '- Actively look for inconsistencies, gaps, and flaws in the design — challenge assumptions, spot contradictions between roles, and raise issues before they become implementation problems\n' +
      '- Be succinct and to the point in all communication — no filler, no restating what was already said\n' +
      '- Never write code or suggest implementation details yourself\n' +
      '- You CANNOT transition to implementation — only the human facilitator can do that via the UI. When you believe planning is complete, tell the human and recommend they end planning.\n' +
      '- Before making significant architecture decisions (tech choices, data models, API design, component boundaries, state management approach), present the options and trade-offs to the human and wait for their approval. You coordinate — the human decides.\n' +
      '- Break larger work into small, sequential phases (e.g. "phase 1: data model + API contracts", "phase 2: backend endpoints", "phase 3: frontend integration"). Plan and implement ONE phase at a time. After each phase completes, start a new planning round for the next. Do not try to plan everything upfront.\n\n' +
      'CRITICAL communication rules:\n' +
      '- Use wait_for_replies (NOT send_message) when you need agent input — it blocks until they respond and returns their replies\n' +
      '- Use send_message ONLY for one-way announcements that need no response\n' +
      '- Always address SPECIFIC agents by role name — there is no broadcast option\n' +
      '- When you receive a reply from one agent, DO NOT automatically forward it to the others. ' +
      'Evaluate whether the reply contains information another agent actually needs (e.g. an API contract, a shared interface decision, a dependency). ' +
      'If it does, extract ONLY the relevant parts and send a targeted summary to the specific agent(s) who need it. ' +
      "If the reply is only relevant to the sender's own domain, do not distribute it at all.\n" +
      '- Use get_new_messages to check if agents have sent anything since your last action\n' +
      '- Do NOT repeat questions agents have already answered — read their replies carefully\n\n' +
      'PLAN STRUCTURE:\n' +
      "- The overview should contain what ALL agents need: goals, constraints, shared interfaces/contracts\n" +
      "- Each role section should contain ONLY that agent's specific tasks, responsibilities, and implementation notes\n" +
      '- When implementation starts, each agent receives ONLY the overview + their own section\n\n' +
      `Feature: ${session.feature ?? ''}\n` +
      `Joined agents: ${agentRoles.join(', ') || 'none yet'}\n\n` +
      `Current plan:\n${planSummary}`
    );
  }

  private async executeTool(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const session = this.store.getSession(sessionId);
    if (!session) return 'Error: session not found';

    switch (name) {
      case 'send_message': {
        const to = input.to as string | undefined;
        if (!to || to === 'all') return 'Error: you must address a specific agent role, not "all". Use wait_for_replies with an array of roles if you need to reach multiple agents.';
        const content = input.content as string;
        this.store.addMessage(sessionId, 'coordinator' as Role, to as Role, content);
        this.lastCheckTs.set(sessionId, Date.now());
        return 'Message sent.';
      }

      case 'wait_for_replies': {
        const toRoles = (input.to as string[]) || [];
        if (toRoles.length === 0) return 'Error: to (array of roles) is required';
        const content = input.content as string;

        const sentAt = Date.now();
        for (const role of toRoles) {
          this.store.addMessage(sessionId, 'coordinator' as Role, role as Role, content);
        }

        const replies = await this.store.waitForRepliesFrom(
          sessionId,
          'coordinator' as Role,
          toRoles,
          120_000,
          sentAt,
        );
        this.lastCheckTs.set(sessionId, Date.now());

        if (replies.length === 0) return '(no replies received within timeout)';
        return replies.map((r) => `[${r.from}]: ${r.content}`).join('\n\n---\n\n');
      }

      case 'get_new_messages': {
        const since = this.lastCheckTs.get(sessionId) ?? 0;
        const msgs = session.messages.filter(
          (m) =>
            m.to === 'coordinator' &&
            m.from !== 'coordinator' &&
            m.timestamp > since,
        );
        this.lastCheckTs.set(sessionId, Date.now());

        if (msgs.length === 0) return '(no new messages from agents)';
        return msgs.map((m) => `[${m.from}]: ${m.content}`).join('\n\n---\n\n');
      }

      case 'update_plan': {
        const overview = (input.overview as string) ?? '';
        const roles = (input.roles as Record<string, string>) ?? {};
        this.store.updatePlan(sessionId, overview, roles);
        return 'Plan updated.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async runLoop(
    sessionId: string,
    session: Session,
    apiKey: string,
    history: Array<{ role: string; content: unknown }>,
    emit: CoordinatorEmitter,
  ): Promise<void> {
    const systemPrompt = this.buildSystemPrompt(session);

    emit.thinking('Coordinator is thinking\u2026');

    while (true) {
      const proxyUrl =
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy;

      const fetchOptions: Record<string, unknown> = {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          messages: history,
          tools: COORDINATOR_TOOLS,
        }),
      };

      if (proxyUrl) {
        fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
      }

      let data: {
        content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        stop_reason: string;
      };

      try {
        const upstream = await fetch(
          'https://api.anthropic.com/v1/messages',
          fetchOptions as RequestInit,
        );
        data = (await upstream.json()) as typeof data;

        if (!upstream.ok) {
          emit.error(`Claude API error ${upstream.status}: ${JSON.stringify(data)}`);
          break;
        }
      } catch (e) {
        emit.error(`Claude API request failed: ${(e as Error).message}`);
        break;
      }

      history.push({ role: 'assistant', content: data.content });

      // Emit text blocks
      const textBlocks = data.content.filter((b) => b.type === 'text');
      if (textBlocks.length) {
        const fullText = textBlocks.map((b) => b.text).join('\n\n');
        // Also post as a session message so it persists
        this.store.addMessage(sessionId, 'coordinator' as Role, '[user]' as Role, fullText);
        emit.text(fullText);
      }

      const toolUses = data.content.filter((b) => b.type === 'tool_use');
      if (data.stop_reason === 'end_turn' || toolUses.length === 0) {
        break;
      }

      // Update thinking indicator
      const waitingFor = toolUses.find((b) => b.name === 'wait_for_replies');
      if (waitingFor) {
        const roles = ((waitingFor.input?.to as string[]) || []).join(', ');
        emit.thinking(`Waiting for replies from ${roles}\u2026`);
      } else {
        emit.thinking('Coordinator is thinking\u2026');
      }

      // Execute tools
      const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
      for (const b of toolUses) {
        emit.toolStart(b.name!, b.input as Record<string, unknown>);
        const result = await this.executeTool(sessionId, b.name!, b.input as Record<string, unknown>);
        emit.toolResult(b.name!, result);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: b.id!,
          content: result,
        });
      }

      history.push({ role: 'user', content: toolResults });

      emit.thinking('Coordinator is thinking\u2026');
    }
  }
}
