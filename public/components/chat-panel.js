import { store } from '../lib/store.js';

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function roleClass(from) {
  if (!from) return 'system';
  if (from === 'coordinator') return 'coordinator';
  if (from === '[user]') return 'user';
  if (from === '[system]') return 'system';
  return 'role-dynamic';
}

class ChatPanel extends HTMLElement {
  #roleTabs = new Set();

  connectedCallback() {
    this.innerHTML = `
      <section class="thread-col">
        <div class="tab-bar" id="tab-bar">
          <button class="tab-btn active" data-tab="chat">Chat</button>
          <button class="tab-btn" data-tab="overview">Overview</button>
        </div>

        <div class="tab-panel active" id="tab-chat">
          <div id="messages">
            <div id="thinking-indicator" class="thinking-indicator hidden">
              <div class="thinking-dots"><span></span><span></span><span></span></div>
              Coordinator is thinking&hellip;
            </div>
          </div>

          <div class="input-bar">
            <div class="input-controls">
              <span>To:</span>
              <select id="to-select">
                <option value="coordinator">coordinator</option>
              </select>
              <span class="kbd-hint">Ctrl+Enter to send</span>
            </div>
            <div class="input-row">
              <textarea id="msg-input" placeholder="Talk to coordinator Claude &mdash; it will engage the agents&hellip;"></textarea>
              <button class="btn-primary" id="send-btn">Send to Claude</button>
              <button class="btn-danger hidden" id="cancel-btn" title="Cancel the running coordinator">Cancel</button>
            </div>
          </div>
        </div>

        <div class="tab-panel" id="tab-overview">
          <div class="plan-view" id="plan-view-overview">
            <span class="empty-plan">No overview yet.</span>
          </div>
        </div>
      </section>
    `;

    this.#setupTabs();
    this.#setupInput();
    this.#bindStore();
  }

  #setupTabs() {
    this.querySelector('#tab-bar').addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      const tabId = btn.dataset.tab;

      this.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      this.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const panel = this.querySelector(`#tab-${tabId}`);
      if (panel) panel.classList.add('active');
    });
  }

  #setupInput() {
    const sendBtn = this.querySelector('#send-btn');
    const input = this.querySelector('#msg-input');
    const cancelBtn = this.querySelector('#cancel-btn');

    sendBtn.addEventListener('click', () => this.#sendToCoordinator());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.#sendToCoordinator();
    });
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      const res = await store.cancelCoordinator();
      cancelBtn.disabled = false;
      if (res.ok) {
        this.#appendLog(`Coordinator cancelled (${res.data.cleared} pending message(s) cleared).`);
      }
    });
  }

  async #sendToCoordinator() {
    const input = this.querySelector('#msg-input');
    const text = input.value.trim();
    if (!text) return;

    if (store.backend === 'api' && !store.apiKey) { alert('Set your Anthropic API key first.'); return; }

    input.value = '';
    await store.sendUserMessage(text);
    store.triggerCoordinator(text);
  }

  #bindStore() {
    store.on('state-changed', () => this.#onStateChanged());
    store.on('coordinator-event', (e) => this.#onCoordinatorEvent(e.detail));
    store.on('log', (e) => this.#appendLog(e.detail));
  }

  #onStateChanged() {
    if (!store.session) return;

    // Update "to" dropdown
    const sel = this.querySelector('#to-select');
    const existing = new Set([...sel.options].map(o => o.value));
    for (const role of store.agentRoles) {
      if (!existing.has(role)) {
        const opt = document.createElement('option');
        opt.value = role; opt.textContent = role;
        sel.appendChild(opt);
        existing.add(role);
      }
      this.#ensureRoleTab(role);
    }

    // Render new messages
    for (const msg of store.session.messages) {
      if (store.renderedIds.has(msg.id)) continue;
      store.renderedIds.add(msg.id);
      this.#renderMessage(msg);
    }

    // Update plan views
    this.#updatePlanViews();

    // Show thinking if coordinator running
    if (store.session.coordinatorRunning) {
      this.#showThinking('Coordinator is thinking\u2026');
    }

    // Auto-trigger
    store.checkAutoTrigger();
  }

  #onCoordinatorEvent(detail) {
    const sendBtn = this.querySelector('#send-btn');
    const cancelBtn = this.querySelector('#cancel-btn');

    switch (detail.type) {
      case 'sending':
        sendBtn.innerHTML = '<span class="spinner"></span>Thinking\u2026';
        cancelBtn.classList.remove('hidden');
        break;
      case 'thinking':
        this.#showThinking(detail.label);
        break;
      case 'text':
        // Text is persisted server-side and rendered via loadState(); no need to render here.
        store.loadState();
        break;
      case 'tool_start':
        this.#showThinking(`Using ${detail.tool}\u2026`);
        break;
      case 'error':
        this.#hideThinking();
        this.#appendLog(`Coordinator error: ${detail.message}`);
        break;
      case 'pending-cleared':
        break;
      case 'done':
        this.#hideThinking();
        sendBtn.textContent = 'Send to Claude';
        cancelBtn.classList.add('hidden');
        break;
    }
  }

  #ensureRoleTab(role) {
    if (this.#roleTabs.has(role)) return;
    this.#roleTabs.add(role);

    const bar = this.querySelector('#tab-bar');
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = `role-${role}`;
    btn.textContent = role;
    bar.appendChild(btn);

    const col = this.querySelector('.thread-col');
    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.id = `tab-role-${role}`;
    panel.innerHTML = `<div class="plan-view" id="plan-view-role-${role}"><span class="empty-plan">No tasks assigned yet.</span></div>`;
    col.appendChild(panel);
  }

  #updatePlanViews() {
    if (!store.session) return;

    const overviewEl = this.querySelector('#plan-view-overview');
    const overviewText = store.session.plan?.overview;
    overviewEl.innerHTML = overviewText
      ? marked.parse(overviewText)
      : '<span class="empty-plan">No overview yet.</span>';

    for (const role of store.agentRoles) {
      this.#ensureRoleTab(role);
      const el = this.querySelector(`#plan-view-role-${role}`);
      const roleText = store.session.plan?.roles?.[role];
      if (el) {
        el.innerHTML = roleText
          ? marked.parse(roleText)
          : '<span class="empty-plan">No tasks assigned yet.</span>';
      }
    }
  }

  #renderMessage(msg) {
    const container = this.querySelector('#messages');
    const cls = roleClass(msg.from);
    const isCoordToAgent = msg.from === 'coordinator' && !['[user]', '[system]', 'coordinator'].includes(msg.to);

    if (isCoordToAgent) {
      const wrapper = document.createElement('div');
      wrapper.className = 'msg msg-collapsed';
      const preview = (msg.content || '').replace(/\s+/g, ' ').slice(0, 80);
      wrapper.innerHTML =
        `<span class="collapsed-toggle">&#9654;</span>` +
        `<span class="collapsed-label">coordinator \u2192 ${escapeHtml(msg.to)}</span>` +
        `<span class="collapsed-preview">${escapeHtml(preview)}${preview.length >= 80 ? '\u2026' : ''}</span>`;
      const full = document.createElement('div');
      full.className = 'collapsed-body hidden';
      full.innerHTML = `<div class="msg-content">${marked.parse(msg.content || '')}</div>`;
      wrapper.appendChild(full);
      wrapper.addEventListener('click', () => {
        const open = !full.classList.contains('hidden');
        full.classList.toggle('hidden');
        wrapper.querySelector('.collapsed-toggle').innerHTML = open ? '&#9654;' : '&#9660;';
      });
      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;
      return;
    }

    const div = document.createElement('div');
    div.className = `msg msg-${cls}`;

    if (cls === 'role-dynamic') {
      const c = store.getRoleColor(msg.from);
      div.style.background = c.bg;
      div.style.border = `1px solid ${c.border}`;
    }

    div.innerHTML =
      `<div class="msg-header">` +
        `<span class="msg-from">${escapeHtml(msg.from || 'unknown')}</span>` +
        `<span class="msg-arrow">\u2192</span>` +
        `<span class="msg-to">${escapeHtml(msg.to || 'unknown')}</span>` +
      `</div>` +
      `<div class="msg-content">${marked.parse(msg.content || '')}</div>` +
      `<div class="msg-time">${new Date(msg.timestamp).toLocaleTimeString()}</div>`;

    if (cls === 'role-dynamic') {
      div.querySelector('.msg-from').style.color = store.getRoleColor(msg.from).fg;
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  #appendLog(text) {
    this.#renderMessage({
      id: crypto.randomUUID(), from: '[system]', to: '[user]',
      content: text, timestamp: Date.now(),
    });
  }

  #showThinking(label) {
    const el = this.querySelector('#thinking-indicator');
    el.textContent = '';
    const dots = document.createElement('div');
    dots.className = 'thinking-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    el.appendChild(dots);
    el.appendChild(document.createTextNode(label || 'Coordinator is thinking\u2026'));
    el.classList.remove('hidden');
    const container = this.querySelector('#messages');
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  #hideThinking() {
    this.querySelector('#thinking-indicator')?.classList.add('hidden');
  }
}

customElements.define('chat-panel', ChatPanel);
