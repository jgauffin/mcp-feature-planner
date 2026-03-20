// ── Application state store (EventTarget-based) ────────────────
// Emits: 'state-changed', 'message-rendered', 'coordinator-event'

import { apiGet, apiPost, apiPatch, apiDelete } from './api.js';

class AppStore extends EventTarget {
  codeword = location.hash.slice(1) || null;
  session = null;
  renderedIds = new Set();
  coordinatorProcessedIds = new Set();
  isSending = false;
  autoTriggerPending = false;
  pollTimer = null;

  // ── Role colors ──────────────────────────────────────────────
  static ROLE_COLORS = [
    { fg: '#56d364', bg: '#1a2e22', border: '#3fb95033' },
    { fg: '#d2a8ff', bg: '#28203d', border: '#bc8cff33' },
    { fg: '#e3b341', bg: '#2d2a1d', border: '#e3b34133' },
    { fg: '#f78166', bg: '#2d1f1a', border: '#f7816633' },
    { fg: '#ff7b72', bg: '#2d1b1b', border: '#ff7b7233' },
    { fg: '#7ee787', bg: '#1a2e22', border: '#7ee78733' },
    { fg: '#a5d6ff', bg: '#1a2533', border: '#a5d6ff33' },
    { fg: '#ffa657', bg: '#2d221a', border: '#ffa65733' },
  ];
  #roleColorMap = new Map();
  #nextColorIdx = 0;

  getRoleColor(role) {
    if (!this.#roleColorMap.has(role)) {
      this.#roleColorMap.set(role, AppStore.ROLE_COLORS[this.#nextColorIdx % AppStore.ROLE_COLORS.length]);
      this.#nextColorIdx++;
    }
    return this.#roleColorMap.get(role);
  }

  // ── API key ──────────────────────────────────────────────────
  get apiKey() {
    return localStorage.getItem('feature-planner-apikey') || '';
  }
  set apiKey(val) {
    localStorage.setItem('feature-planner-apikey', val.trim());
  }

  // ── Session lifecycle ────────────────────────────────────────
  async createSession(feature) {
    const res = await apiPost('/session', { feature });
    if (!res.ok) throw new Error(JSON.stringify(res.data));
    this.codeword = res.data.codeword;
    location.hash = this.codeword;
    return this.codeword;
  }

  resumeSession(codeword) {
    this.codeword = codeword;
    location.hash = codeword;
  }

  async loadState() {
    const res = await apiGet(`/session/${this.codeword}/state`).catch(() => null);
    if (!res?.ok) {
      if (res?.status === 404 && this.pollTimer) {
        this.stopPolling();
        this.emit('log', 'Session not found \u2014 server may have restarted. Please create a new session.');
      }
      return;
    }
    this.session = res.data;
    this.emit('state-changed');
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.loadState(), 3000);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ── Plan ─────────────────────────────────────────────────────
  async savePlan(overview, roles) {
    await apiPatch(`/session/${this.codeword}/plan`, { overview, roles });
    if (this.session) this.session.plan = { overview, roles };
  }

  async startCoding(overview, roles) {
    await this.savePlan(overview, roles);
    const res = await apiPost(`/session/${this.codeword}/phase`, { phase: 'implementing' });
    if (!res.ok) throw new Error(JSON.stringify(res.data));
    await this.loadState();
  }

  // ── Coordinator ──────────────────────────────────────────────
  async sendUserMessage(text) {
    await apiPost(`/session/${this.codeword}/message`, {
      from: '[user]', to: 'coordinator', content: text,
    });
    await this.loadState();
  }

  triggerCoordinator(message) {
    if (this.isSending) return;
    this.isSending = true;
    this.emit('coordinator-event', { type: 'sending' });

    fetch(`/session/${this.codeword}/coordinator/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, apiKey: this.apiKey }),
    }).then(response => {
      if (!response.ok) {
        response.json().then(data => {
          this.emit('log', `Coordinator error: ${data.error || response.statusText}`);
          this.#finishCoordinator();
        }).catch(() => {
          this.emit('log', `Coordinator error: ${response.statusText}`);
          this.#finishCoordinator();
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processSSE = (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              this.#handleCoordinatorEvent(eventType, data);
            } catch { /* ignore malformed data */ }
          }
        }
      };

      const read = () => {
        reader.read().then(({ done, value }) => {
          if (done) { this.#finishCoordinator(); return; }
          processSSE(decoder.decode(value, { stream: true }));
          read();
        }).catch(() => {
          this.#finishCoordinator();
        });
      };
      read();
    }).catch(err => {
      this.emit('log', `Coordinator request failed: ${err.message}`);
      this.#finishCoordinator();
    });
  }

  #handleCoordinatorEvent(type, data) {
    switch (type) {
      case 'thinking':
        this.emit('coordinator-event', { type: 'thinking', label: data.label });
        break;
      case 'text':
        this.emit('coordinator-event', { type: 'text', content: data.content });
        break;
      case 'tool_start':
        this.emit('coordinator-event', { type: 'tool_start', tool: data.tool });
        break;
      case 'tool_result':
        this.loadState();
        break;
      case 'done':
        this.#finishCoordinator();
        break;
      case 'error':
        this.emit('coordinator-event', { type: 'error', message: data.message });
        break;
    }
  }

  #finishCoordinator() {
    this.isSending = false;
    this.autoTriggerPending = false;
    this.emit('coordinator-event', { type: 'done' });
    this.loadState();
  }

  // ── Pending message management ──────────────────────────────
  async cancelPending() {
    const res = await apiDelete(`/session/${this.codeword}/coordinator/pending`);
    if (res.ok) {
      this.autoTriggerPending = false;
      this.emit('coordinator-event', { type: 'pending-cleared', cleared: res.data.cleared });
    }
    return res;
  }

  // ── Auto-trigger ─────────────────────────────────────────────
  checkAutoTrigger() {
    if (!this.session || this.isSending || this.autoTriggerPending) return;

    const newAgentMessages = this.session.messages.filter(m =>
      !this.coordinatorProcessedIds.has(m.id) &&
      m.from !== 'coordinator' &&
      m.from !== '[user]' &&
      m.from !== '[system]' &&
      m.to === 'coordinator'
    );

    if (newAgentMessages.length > 0) {
      if (!this.apiKey) return;
      this.autoTriggerPending = true;
      for (const m of newAgentMessages) this.coordinatorProcessedIds.add(m.id);

      const summary = newAgentMessages
        .map(m => `[${m.from} \u2192 ${m.to}]: ${m.content}`)
        .join('\n\n---\n\n');
      this.triggerCoordinator(`New messages from agents:\n\n${summary}`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────
  get agentRoles() {
    return (this.session?.joinedRoles || []).filter(r => r !== 'coordinator');
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  on(name, fn) {
    this.addEventListener(name, fn);
  }
}

export const store = new AppStore();
