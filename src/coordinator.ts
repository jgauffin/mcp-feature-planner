import type { SessionStore } from './session-store.js';
import type { Role, Session } from './types.js';
import type { CoordinatorBackend, BackendType, CoordinatorToolDef } from './coordinator/coordinator-backend.js';
import { AnthropicApiBackend } from './coordinator/coordinator-api-backend.js';
import { ClaudeCodeBackend } from './coordinator/coordinator-claudecode-backend.js';

export interface CoordinatorEmitter {
  thinking(label: string): void;
  text(content: string): void;
  toolStart(tool: string, input: Record<string, unknown>): void;
  toolResult(tool: string, result: string): void;
  done(): void;
  error(message: string): void;
}

// ── Shared messaging tools (same for both backends) ─────────────

const MESSAGING_TOOLS: CoordinatorToolDef[] = [
  {
    name: 'send_message',
    description:
      'Send a one-way message to a specific agent. Use this only for announcements or instructions that do NOT need a response. For messages that need agent input, use wait_for_replies instead.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target role label (e.g. "backend", "frontend"). Must be a specific agent role.',
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
];

// ── Plan tool: full replace (Claude Code backend) ───────────────

const UPDATE_PLAN_TOOL: CoordinatorToolDef = {
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
        description: 'Per-role plan sections. Keys are role labels, values are markdown task lists for that role.',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['overview', 'roles'],
  },
};

// ── Plan tool: diff/patch (API backend — saves tokens) ──────────

const PATCH_PLAN_TOOL: CoordinatorToolDef = {
  name: 'patch_plan',
  description:
    'Apply a partial update to the plan. Only include sections you want to change. ' +
    'Omit overview to leave it unchanged. Only include role keys you want to update. ' +
    'Set a role value to "" to remove that role section. ' +
    'The current plan is included in the system prompt — read it there, then send only your changes.',
  input_schema: {
    type: 'object',
    properties: {
      overview: {
        type: 'string',
        description: 'New overview text. Omit to keep current overview unchanged.',
      },
      roles: {
        type: 'object',
        description:
          'Role sections to add or update. Only include roles you are changing. ' +
          'Set value to "" to remove a role. Omitted roles are left untouched.',
        additionalProperties: { type: 'string' },
      },
    },
  },
};

/** Tools for the Claude Code backend (full plan updates, full history). */
export const COORDINATOR_TOOLS: CoordinatorToolDef[] = [
  ...MESSAGING_TOOLS,
  UPDATE_PLAN_TOOL,
];

/** Tools for the API backend (diff-based plan updates, no history). */
const API_COORDINATOR_TOOLS: CoordinatorToolDef[] = [
  ...MESSAGING_TOOLS,
  PATCH_PLAN_TOOL,
];

// ── System prompts ──────────────────────────────────────────────

const STATIC_SYSTEM_PROMPT =
  'You are a technical planning coordinator facilitating a design session ' +
  'between one or more developer agents.\n\n' +
  'Your responsibilities:\n' +
  '- Ask each agent TARGETED questions about their specific domain\n' +
  '- Identify interfaces between roles (API contracts, shared state, events)\n' +
  '- Synthesize into a STRUCTURED PLAN via the plan tool with:\n' +
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
  '- When implementation starts, each agent receives ONLY the overview + their own section';

/**
 * For the API backend, we append the current plan + session context to the
 * system prompt so the LLM has state even though we don't send history.
 */
function buildApiSystemPrompt(session: Session): string {
  const agentRoles = session.joinedRoles.filter((r) => r !== 'coordinator');

  const planSnapshot = formatPlanSnapshot(session);

  return (
    STATIC_SYSTEM_PROMPT +
    '\n\n' +
    'IMPORTANT: You have NO conversation history. Each call is independent. ' +
    'The current plan and session context below are your only state. ' +
    'Use patch_plan to make incremental changes — only send the sections you want to change.\n\n' +
    `Feature: ${session.feature ?? ''}\n` +
    `Joined agents: ${agentRoles.join(', ') || 'none yet'}\n\n` +
    `Current plan:\n${planSnapshot}`
  );
}

function formatPlanSnapshot(session: Session): string {
  const agentRoles = session.joinedRoles.filter((r) => r !== 'coordinator');
  if (!session.plan.overview && Object.keys(session.plan.roles).length === 0) {
    return '(no plan yet)';
  }
  let s = `Overview:\n${session.plan.overview || '(empty)'}\n`;
  for (const r of agentRoles) {
    s += `\n${r}:\n${session.plan.roles[r] || '(empty)'}\n`;
  }
  return s;
}

// ── CoordinatorRunner ───────────────────────────────────────────

export class CoordinatorRunner {
  /** Full history — used only by Claude Code backend. */
  private histories = new Map<string, Array<{ role: string; content: unknown }>>();
  private initializedSessions = new Set<string>();
  private pendingMessages = new Map<string, string[]>();
  private lastCheckTs = new Map<string, number>();
  private running = new Map<string, boolean>();
  private abortControllers = new Map<string, AbortController>();
  private backends = new Map<string, CoordinatorBackend>();
  private backendType: BackendType;

  constructor(
    private store: SessionStore,
    backendType: BackendType = 'api',
  ) {
    this.backendType = backendType;
  }

  isRunning(sessionId: string): boolean {
    return this.running.get(sessionId) === true;
  }

  async trigger(
    sessionId: string,
    userMessage: string | null,
    apiKey: string,
    emit: CoordinatorEmitter,
    backendOverride?: BackendType,
  ): Promise<void> {
    if (this.running.get(sessionId)) {
      emit.error('Coordinator is already running for this session.');
      return;
    }

    this.running.set(sessionId, true);
    const ac = new AbortController();
    this.abortControllers.set(sessionId, ac);

    try {
      const session = this.store.getSession(sessionId);
      if (!session) {
        emit.error('Session not found.');
        return;
      }

      const effectiveBackend = backendOverride ?? this.backendType;
      const backend = this.getOrCreateBackend(sessionId, effectiveBackend, apiKey);

      const executeTool = (name: string, input: Record<string, unknown>, signal: AbortSignal) =>
        this.executeTool(sessionId, name, input, signal);

      const sessionStore = this.store;
      const wrappedEmit: CoordinatorEmitter = {
        ...emit,
        text(content: string) {
          sessionStore.addMessage(sessionId, 'coordinator' as Role, '[user]' as Role, content);
          emit.text(content);
        },
      };

      if (effectiveBackend === 'api') {
        await this.triggerApi(sessionId, session, userMessage, backend, executeTool, wrappedEmit, ac.signal);
      } else {
        await this.triggerClaudeCode(sessionId, session, userMessage, backend, executeTool, wrappedEmit, ac.signal);
      }
    } finally {
      this.running.set(sessionId, false);
      this.abortControllers.delete(sessionId);
      emit.done();
    }
  }

  /**
   * API backend trigger: build a fresh minimal message list each call.
   * No accumulated history — the system prompt contains the plan snapshot.
   */
  private async triggerApi(
    sessionId: string,
    session: Session,
    userMessage: string | null,
    backend: CoordinatorBackend,
    executeTool: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<string>,
    emit: CoordinatorEmitter,
    signal: AbortSignal,
  ): Promise<void> {
    // Build ephemeral messages — only new content for this turn
    const messages: Array<{ role: string; content: unknown }> = [];

    if (userMessage) {
      messages.push({ role: 'user', content: userMessage });
    }

    // Include any pending queued messages
    const pending = this.pendingMessages.get(sessionId);
    if (pending && pending.length > 0) {
      for (const msg of pending) {
        messages.push({ role: 'user', content: msg });
      }
      this.pendingMessages.delete(sessionId);
    }

    // Ensure at least one user message (API requires it)
    if (messages.length === 0) {
      messages.push({ role: 'user', content: 'Continue coordinating the planning session.' });
    }

    // Re-read session for fresh plan state
    const freshSession = this.store.getSession(sessionId) ?? session;
    const systemPrompt = buildApiSystemPrompt(freshSession);

    await backend.runLoop(
      systemPrompt,
      messages,
      API_COORDINATOR_TOOLS,
      executeTool,
      emit,
      signal,
      sessionId,
    );
  }

  /**
   * Claude Code backend trigger: accumulate full history, resume session.
   */
  private async triggerClaudeCode(
    sessionId: string,
    session: Session,
    userMessage: string | null,
    backend: CoordinatorBackend,
    executeTool: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<string>,
    emit: CoordinatorEmitter,
    signal: AbortSignal,
  ): Promise<void> {
    const history = this.histories.get(sessionId) ?? [];

    // Always prepend fresh session context to the user message so the
    // Claude Code subprocess knows which agents are connected (roles can
    // change between triggers as new agents join).
    const freshSession = this.store.getSession(sessionId) ?? session;
    const context = this.buildSessionContext(freshSession);
    const combinedMessage = userMessage
      ? `${context}\n\n---\n\n${userMessage}`
      : context;
    history.push({ role: 'user', content: combinedMessage });
    this.initializedSessions.add(sessionId);

    this.drainPendingMessages(sessionId, history);
    this.histories.set(sessionId, history);

    await backend.runLoop(
      STATIC_SYSTEM_PROMPT,
      history,
      COORDINATOR_TOOLS,
      executeTool,
      emit,
      signal,
      sessionId,
    );
  }

  queueAndTrigger(
    sessionId: string,
    userMessage: string,
    apiKey: string,
    emit: CoordinatorEmitter,
  ): void {
    if (this.running.get(sessionId)) {
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

  cancel(sessionId: string): boolean {
    const ac = this.abortControllers.get(sessionId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  pendingCount(sessionId: string): number {
    return this.pendingMessages.get(sessionId)?.length ?? 0;
  }

  private buildSessionContext(session: Session): string {
    const agentRoles = session.joinedRoles.filter((r) => r !== 'coordinator');
    const planSnapshot = formatPlanSnapshot(session);

    return (
      `[Session context]\n` +
      `Feature: ${session.feature ?? ''}\n` +
      `Joined agents: ${agentRoles.join(', ') || 'none yet'}\n\n` +
      `Current plan:\n${planSnapshot}`
    );
  }

  private getOrCreateBackend(sessionId: string, type: BackendType, apiKey: string): CoordinatorBackend {
    const existing = this.backends.get(sessionId);
    if (existing) return existing;

    let backend: CoordinatorBackend;
    switch (type) {
      case 'api':
        backend = new AnthropicApiBackend(apiKey);
        break;
      case 'claude-code':
        backend = new ClaudeCodeBackend(this.store);
        break;
      default:
        throw new Error(`Unknown backend type: ${type}`);
    }

    this.backends.set(sessionId, backend);
    return backend;
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

  private async executeTool(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
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
          signal,
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

      // Claude Code backend: full plan replace
      case 'update_plan': {
        const overview = (input.overview as string) ?? '';
        const roles = (input.roles as Record<string, string>) ?? {};
        this.store.updatePlan(sessionId, overview, roles);
        return 'Plan updated.';
      }

      // API backend: diff-based plan patch
      case 'patch_plan': {
        const overview = input.overview !== undefined ? (input.overview as string) : null;
        const roles = input.roles !== undefined ? (input.roles as Record<string, string>) : null;
        if (overview === null && roles === null) return 'No changes provided.';
        this.store.patchPlan(sessionId, overview, roles);
        return 'Plan patched.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }
}
