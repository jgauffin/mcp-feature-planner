import { store } from '../lib/store.js';

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

class PlanSidebar extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <aside class="design-col">
        <span class="section-label">Plan &mdash; Overview</span>
        <textarea id="plan-overview" class="plan-textarea" placeholder="Shared context: goals, constraints, API contracts&hellip;"></textarea>

        <span class="section-label">Plan &mdash; Per Role</span>
        <div id="role-plans"></div>

        <div class="plan-actions">
          <button class="btn-secondary" id="save-plan-btn">Save Plan</button>
          <button class="btn-primary" id="end-planning-btn" disabled>Start Coding</button>
        </div>

        <div class="divider"></div>

        <span class="section-label">Session</span>
        <div id="joined-roles">No agents joined yet.</div>
        <p class="copy-hint">Share the codeword &uarr; with your Claude Code agents</p>

        <div class="divider"></div>

        <span class="section-label">Join Command</span>
        <p class="copy-hint" style="text-align:left">Paste this into a Claude Code session &mdash; replace <strong>&lt;ROLE&gt;</strong> with the agent role:</p>
        <div id="join-snippet" class="join-snippet" title="Click to copy">
          <span class="copy-icon">&#128203;</span>
        </div>
      </aside>
    `;

    this.#setupSavePlan();
    this.#setupEndPlanning();
    this.#setupJoinSnippet();
    this.#bindStore();
  }

  #setupSavePlan() {
    this.querySelector('#save-plan-btn').addEventListener('click', () => this.#savePlan());
  }

  #setupEndPlanning() {
    this.querySelector('#end-planning-btn').addEventListener('click', async () => {
      if (!confirm('Start coding? This will end the planning phase and send each agent their tasks.')) return;
      const btn = this.querySelector('#end-planning-btn');
      btn.disabled = true;
      btn.textContent = 'Switching\u2026';
      try {
        const { overview, roles } = this.#collectPlan();
        await store.startCoding(overview, roles);
      } catch (e) {
        alert('Error: ' + e.message);
      }
      btn.textContent = 'Start Coding';
    });
  }

  #setupJoinSnippet() {
    this.querySelector('#join-snippet').addEventListener('click', () => {
      const text = `Use the MCP tool "join_session" with codeword "${store.codeword}" and role <ROLE>`;
      navigator.clipboard.writeText(text);
      const el = this.querySelector('#join-snippet');
      const prev = el.innerHTML;
      el.innerHTML = '<span class="copy-icon">\u2713</span> Copied!';
      setTimeout(() => el.innerHTML = prev, 1500);
    });
  }

  #bindStore() {
    store.on('state-changed', () => this.#onStateChanged());
  }

  #onStateChanged() {
    if (!store.session) return;

    // End planning button
    this.querySelector('#end-planning-btn').disabled = store.session.phase !== 'planning';

    // Joined roles
    const rolesEl = this.querySelector('#joined-roles');
    rolesEl.textContent = store.session.joinedRoles.length
      ? 'Connected: ' + store.session.joinedRoles.join(', ')
      : 'No agents joined yet.';

    // Plan overview
    const overviewEl = this.querySelector('#plan-overview');
    if (document.activeElement !== overviewEl) {
      overviewEl.value = store.session.plan?.overview || '';
    }

    // Per-role plan sections
    const rolePlansEl = this.querySelector('#role-plans');
    for (const role of store.agentRoles) {
      let section = this.querySelector(`#role-plan-${role}`)?.closest('.role-plan-section');
      if (!section) {
        section = document.createElement('div');
        section.className = 'role-plan-section';
        section.innerHTML =
          `<div class="role-plan-label">${escapeHtml(role)}</div>` +
          `<textarea id="role-plan-${role}" class="plan-textarea" placeholder="Tasks for ${escapeHtml(role)}\u2026"></textarea>`;
        rolePlansEl.appendChild(section);
      }
      const ta = section.querySelector('textarea');
      if (ta && document.activeElement !== ta) {
        ta.value = store.session.plan?.roles?.[role] || '';
      }
    }

    // Join snippet
    this.#updateJoinSnippet();
  }

  #updateJoinSnippet() {
    const el = this.querySelector('#join-snippet');
    el.innerHTML = `<span class="copy-icon">\ud83d\udccb</span>` +
      `Use the MCP tool "join_session" with codeword "${store.codeword}" and role <span class="placeholder">&lt;ROLE&gt;</span>`;
  }

  #collectPlan() {
    const overview = this.querySelector('#plan-overview').value;
    const roles = {};
    for (const role of store.agentRoles) {
      const ta = this.querySelector(`#role-plan-${role}`);
      if (ta) roles[role] = ta.value;
    }
    return { overview, roles };
  }

  async #savePlan() {
    const { overview, roles } = this.#collectPlan();
    await store.savePlan(overview, roles);
  }
}

customElements.define('plan-sidebar', PlanSidebar);
