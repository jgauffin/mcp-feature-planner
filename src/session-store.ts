import { v4 as uuidv4 } from 'uuid';
import type { Message, Phase, Role, Session } from './types.js';

const ADJECTIVES = [
  'swift', 'bold', 'calm', 'dark', 'eager', 'fair', 'glad', 'hard',
  'idle', 'keen', 'loud', 'mild', 'neat', 'open', 'pale', 'quiet',
  'rich', 'safe', 'tall', 'vast', 'warm', 'wise', 'young', 'zeal',
  'brave', 'clear', 'deep', 'firm', 'grand', 'sharp', 'solid', 'quick',
];

const NOUNS = [
  'falcon', 'river', 'stone', 'cloud', 'ember', 'frost', 'grove', 'harbor',
  'island', 'jungle', 'kindle', 'lantern', 'meadow', 'nexus', 'orbit', 'pixel',
  'quest', 'raven', 'signal', 'tower', 'utopia', 'valley', 'willow', 'xenon',
  'yarn', 'zenith', 'anchor', 'bridge', 'cipher', 'delta', 'echo', 'flare',
];

interface WaitingPoll {
  role: Role;
  after: string | null;
  resolve: (messages: Message[]) => void;
}

const PLAN_PREFIX =
  '[PLAN MODE - DO NOT WRITE CODE]\n' +
  'Discuss design, raise concerns, ask questions, propose approaches only.\n' +
  'No code snippets, no implementation details.\n\n---\n';

export class SessionStore {
  private sessions = new Map<string, Session>();
  private codewords = new Map<string, string>(); // codeword → sessionId
  private waiters = new Map<string, WaitingPoll[]>();

  private generateCodeword(): string {
    for (let i = 0; i < 100; i++) {
      const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
      const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
      const codeword = `${adj}-${noun}`;
      if (!this.codewords.has(codeword)) return codeword;
    }
    throw new Error('Could not generate unique codeword');
  }

  createSession(feature: string): Session {
    const id = uuidv4();
    const codeword = this.generateCodeword();
    const session: Session = {
      id,
      codeword,
      phase: 'planning',
      feature,
      designDoc: '',
      messages: [],
      joinedRoles: [],
    };
    this.sessions.set(id, session);
    this.codewords.set(codeword, id);
    this.waiters.set(id, []);
    return session;
  }

  getByCodeword(codeword: string): Session | undefined {
    const id = this.codewords.get(codeword);
    if (!id) return undefined;
    return this.sessions.get(id);
  }

  joinSession(
    codeword: string,
    role: Role,
  ): { phase: Phase; feature: string; instructions: string; joinedRoles: Role[] } {
    const session = this.getByCodeword(codeword);
    if (!session) throw new Error(`Session not found: ${codeword}`);

    if (!session.joinedRoles.includes(role)) {
      session.joinedRoles.push(role);
    }

    const instructions =
      `You have joined session "${codeword}" as: ${role}\n` +
      `Feature: ${session.feature}\n\n` +
      `PHASE: ${session.phase.toUpperCase()}\n\n` +
      (session.phase === 'planning'
        ? `You are in PLAN MODE. Rules:\n` +
          `- Discuss design only — raise concerns, ask questions, propose approaches\n` +
          `- NO code, NO implementation details\n` +
          `- Use send_message to communicate\n` +
          `- Use get_messages(codeword, role) in a loop to receive messages\n` +
          `- Use ask_coordinator(codeword, role, question) to block until the coordinator responds\n` +
          `- Stay in plan mode until you receive a [IMPLEMENTATION MODE] message\n`
        : `Planning is complete. Proceed with implementation.\n`);

    return { phase: session.phase, feature: session.feature, instructions, joinedRoles: session.joinedRoles };
  }

  addMessage(sessionId: string, from: Role, to: Role | 'all', content: string): Message {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const prefixed =
      session.phase === 'planning' && from !== 'coordinator'
        ? PLAN_PREFIX + content
        : content;

    const message: Message = {
      id: uuidv4(),
      from,
      to,
      content: prefixed,
      timestamp: Date.now(),
    };

    session.messages.push(message);
    this.notifyWaiters(sessionId, message);
    return message;
  }

  private getMessagesSince(session: Session, role: Role, after: string | null): Message[] {
    const msgs = session.messages.filter(
      (m) => m.to === role || m.to === 'all',
    );
    if (!after) return msgs;
    const idx = msgs.findIndex((m) => m.id === after);
    return idx === -1 ? msgs : msgs.slice(idx + 1);
  }

  waitForMessages(
    sessionId: string,
    role: Role,
    after: string | null,
    timeoutMs: number,
  ): Promise<Message[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error(`Session not found: ${sessionId}`));

    const existing = this.getMessagesSince(session, role, after);
    if (existing.length > 0) return Promise.resolve(existing);

    return new Promise<Message[]>((resolve) => {
      const waiter: WaitingPoll = { role, after, resolve };
      const list = this.waiters.get(sessionId) ?? [];
      list.push(waiter);
      this.waiters.set(sessionId, list);

      setTimeout(() => {
        const remaining = this.waiters.get(sessionId) ?? [];
        const idx = remaining.indexOf(waiter);
        if (idx !== -1) {
          remaining.splice(idx, 1);
          resolve([]);
        }
      }, timeoutMs);
    });
  }

  private notifyWaiters(sessionId: string, message: Message): void {
    const list = this.waiters.get(sessionId) ?? [];
    const toNotify = list.filter(
      (w) => message.to === w.role || message.to === 'all',
    );
    for (const waiter of toNotify) {
      const idx = list.indexOf(waiter);
      if (idx !== -1) list.splice(idx, 1);
      const session = this.sessions.get(sessionId)!;
      const msgs = this.getMessagesSince(session, waiter.role, waiter.after);
      waiter.resolve(msgs);
    }
  }

  setPhase(sessionId: string, phase: Phase): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.phase = phase;

    if (phase === 'implementing') {
      const roles = session.joinedRoles.filter((r) => r !== 'coordinator');
      const designSnippet = session.designDoc || '(no design doc yet)';
      const content =
        `[IMPLEMENTATION MODE]\n` +
        `Planning is complete. Agreed design:\n\n${designSnippet}\n\n---\n` +
        `Proceed with implementation.`;

      for (const role of roles) {
        this.addMessage(sessionId, 'coordinator', role, content);
      }
    }
  }

  updateDesignDoc(sessionId: string, designDoc: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.designDoc = designDoc;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }
}
