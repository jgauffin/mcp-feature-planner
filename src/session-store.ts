import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Message, Phase, Plan, Role, Session } from './types.js';

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

interface WaitingForReplies {
  toRole: Role;
  expectedFrom: Set<string>;
  afterTimestamp: number;
  resolve: (messages: Message[]) => void;
}


const DATA_DIR = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'data');
const DATA_FILE = join(DATA_DIR, 'sessions.json');

export class SessionStore {
  private sessions = new Map<string, Session>();
  private codewords = new Map<string, string>(); // codeword → sessionId
  private waiters = new Map<string, WaitingPoll[]>();
  private replyWaiters = new Map<string, WaitingForReplies[]>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(DATA_FILE, 'utf-8');
      const list: Session[] = JSON.parse(raw);
      for (const s of list) {
        this.sessions.set(s.id, s);
        this.codewords.set(s.codeword, s.id);
        this.waiters.set(s.id, []);
      }
      console.log(`Loaded ${list.length} session(s) from disk.`);
    } catch {
      // No file yet or corrupt — start fresh
    }
  }

  private save(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const list = Array.from(this.sessions.values());
      writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
    } catch (err) {
      console.error('Failed to persist sessions:', err);
    }
  }

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
      plan: { overview: '', roles: {} },
      messages: [],
      joinedRoles: [],
    };
    this.sessions.set(id, session);
    this.codewords.set(codeword, id);
    this.waiters.set(id, []);
    this.save();
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
      this.save();
    }

    const instructions =
      `You have joined session "${codeword}" as: ${role}\n` +
      `Feature: ${session.feature}\n\n` +
      `PHASE: ${session.phase.toUpperCase()}\n\n` +
      `IMPORTANT: You MUST call get_messages in a continuous loop for the entire session. ` +
      `Never stop polling — even when get_messages returns no messages, call it again immediately. ` +
      `The coordinator will send you questions and instructions through this channel.\n\n` +
      (session.phase === 'planning'
        ? `You are in PLAN MODE. Rules:\n` +
          `- Discuss design only — raise concerns, ask questions, propose approaches\n` +
          `- NO code, NO implementation details\n` +
          `- Use send_message to communicate, use get_messages to receive\n` +
          `- Use ask_coordinator(codeword, role, question) to block until the coordinator responds\n` +
          `- Stay in plan mode until you receive a [IMPLEMENTATION MODE] message\n`
        : `Planning is complete. Proceed with implementation.\n`);

    return { phase: session.phase, feature: session.feature, instructions, joinedRoles: session.joinedRoles };
  }

  addMessage(sessionId: string, from: Role, to: Role | 'all', content: string): Message {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const message: Message = {
      id: uuidv4(),
      from,
      to,
      content,
      timestamp: Date.now(),
    };

    session.messages.push(message);
    this.save();
    this.notifyWaiters(sessionId, message);
    return message;
  }

  private getMessagesSince(session: Session, role: Role, after: string | null): Message[] {
    const msgs = session.messages.filter(
      role === 'coordinator'
        ? (m) => m.from !== 'coordinator'   // coordinator sees everything except its own
        : (m) => m.to === role || m.to === 'all',
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
    // Notify single-role waiters
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

    // Notify multi-role reply waiters
    const rList = this.replyWaiters.get(sessionId) ?? [];
    for (let i = rList.length - 1; i >= 0; i--) {
      const rw = rList[i];
      if (message.to !== rw.toRole && message.to !== 'all') continue;
      rw.expectedFrom.delete(message.from);
      if (rw.expectedFrom.size === 0) {
        rList.splice(i, 1);
        const session = this.sessions.get(sessionId)!;
        const msgs = session.messages.filter(
          (m) => (m.to === rw.toRole || m.to === 'all') && m.timestamp >= rw.afterTimestamp,
        );
        rw.resolve(msgs);
      }
    }
  }

  waitForRepliesFrom(
    sessionId: string,
    toRole: Role,
    expectedFrom: string[],
    timeoutMs: number,
    afterTimestamp?: number,
  ): Promise<Message[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error(`Session not found: ${sessionId}`));

    const cutoff = afterTimestamp ?? Date.now();
    const remaining = new Set(expectedFrom);

    // Check if any of the expected roles already sent messages since the cutoff
    for (const msg of session.messages) {
      if (msg.timestamp >= cutoff && (msg.to === toRole || msg.to === 'all')) {
        remaining.delete(msg.from);
      }
    }
    if (remaining.size === 0) {
      const msgs = session.messages.filter(
        (m) => (m.to === toRole || m.to === 'all') && m.timestamp >= cutoff,
      );
      return Promise.resolve(msgs);
    }

    return new Promise<Message[]>((resolve) => {
      const waiter: WaitingForReplies = {
        toRole,
        expectedFrom: remaining,
        afterTimestamp: cutoff,
        resolve,
      };
      const list = this.replyWaiters.get(sessionId) ?? [];
      list.push(waiter);
      this.replyWaiters.set(sessionId, list);

      setTimeout(() => {
        const current = this.replyWaiters.get(sessionId) ?? [];
        const idx = current.indexOf(waiter);
        if (idx !== -1) {
          current.splice(idx, 1);
          // Resolve with whatever we have so far
          const session = this.sessions.get(sessionId);
          const msgs = session
            ? session.messages.filter(
                (m) => (m.to === toRole || m.to === 'all') && m.timestamp >= waiter.afterTimestamp,
              )
            : [];
          resolve(msgs);
        }
      }, timeoutMs);
    });
  }

  setPhase(sessionId: string, phase: Phase): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.phase = phase;
    this.save();

    if (phase === 'implementing') {
      const roles = session.joinedRoles.filter((r) => r !== 'coordinator');
      const overview = session.plan.overview || '(no overview)';

      for (const role of roles) {
        const roleSection = session.plan.roles[role] || '(no specific tasks assigned)';
        const content =
          `[IMPLEMENTATION MODE]\n` +
          `Planning is complete.\n\n` +
          `## Overview\n${overview}\n\n` +
          `## Your tasks (${role})\n${roleSection}\n\n---\n` +
          `Proceed with implementation.`;
        this.addMessage(sessionId, 'coordinator', role, content);
      }
    }
  }

  updatePlan(sessionId: string, overview: string, roles: Record<string, string>): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.plan = { overview, roles };
    this.save();
  }

  updateRolePlan(sessionId: string, role: Role, content: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.plan.roles[role] = content;
    this.save();
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): { codeword: string; feature: string; phase: Phase; roles: Role[] }[] {
    return Array.from(this.sessions.values()).map((s) => ({
      codeword: s.codeword,
      feature: s.feature,
      phase: s.phase,
      roles: s.joinedRoles,
    }));
  }
}
