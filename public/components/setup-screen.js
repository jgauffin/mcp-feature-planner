import { store } from '../lib/store.js';
import { apiGet } from '../lib/api.js';

class SetupScreen extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div id="setup">
        <div class="setup-card">
          <h1>Feature Planner</h1>
          <p>Start a collaborative planning session, then share the codeword with your Claude Code agents so they can join.</p>

          <div class="field">
            <label for="feature-input">Feature to plan</label>
            <input type="text" id="feature-input" placeholder="e.g. User authentication flow" />
          </div>

          <div class="field">
            <label for="backend-select">Coordinator backend</label>
            <select id="backend-select">
              <option value="api">Anthropic API (direct)</option>
              <option value="claude-code">Claude Code (CLI)</option>
            </select>
            <span class="hint">Choose how the coordinator LLM is invoked</span>
          </div>

          <div class="field" id="apikey-field">
            <label for="apikey-input">Anthropic API key</label>
            <input type="password" id="apikey-input" placeholder="sk-ant-..." />
            <span class="hint">Stored in localStorage &middot; sent to your local server for coordinator calls</span>
          </div>

          <button class="btn-primary" id="start-btn">Start Session</button>

          <div class="divider" style="height:1px;background:#30363d;margin:4px 0"></div>

          <div class="field">
            <label>Or resume an existing session</label>
            <select id="existing-sessions">
              <option value="">Loading&hellip;</option>
            </select>
          </div>
          <button class="btn-secondary" id="resume-btn" disabled>Resume Session</button>
        </div>
      </div>
    `;

    this.#setupBackend();
    this.#setupApiKey();
    this.#setupStart();
    this.#setupResume();
    this.#loadExistingSessions();
    this.#autoRestore();
  }

  #setupBackend() {
    const $backend = this.querySelector('#backend-select');
    const $apikeyField = this.querySelector('#apikey-field');
    $backend.value = store.backend;

    const toggleApiKey = () => {
      $apikeyField.style.display = $backend.value === 'claude-code' ? 'none' : '';
    };
    toggleApiKey();

    $backend.addEventListener('change', () => {
      store.backend = $backend.value;
      toggleApiKey();
    });
  }

  #setupApiKey() {
    const $apikey = this.querySelector('#apikey-input');
    $apikey.value = store.apiKey;
    $apikey.addEventListener('input', () => { store.apiKey = $apikey.value; });
  }

  #setupStart() {
    this.querySelector('#start-btn').addEventListener('click', async () => {
      const feature = this.querySelector('#feature-input').value.trim();
      if (!feature) { alert('Enter a feature name.'); return; }
      if (store.backend === 'api') {
        const apiKey = this.querySelector('#apikey-input').value.trim();
        if (!apiKey) { alert('Enter your Anthropic API key.'); return; }
      }

      try {
        await store.createSession(feature);
        this.#enterApp();
      } catch (e) {
        alert('Failed to create session: ' + e.message);
      }
    });
  }

  #setupResume() {
    const sel = this.querySelector('#existing-sessions');
    const btn = this.querySelector('#resume-btn');

    sel.addEventListener('change', () => { btn.disabled = !sel.value; });

    btn.addEventListener('click', () => {
      if (store.backend === 'api') {
        const apiKey = this.querySelector('#apikey-input').value.trim();
        if (!apiKey) { alert('Enter your Anthropic API key.'); return; }
      }
      if (!sel.value) return;

      store.resumeSession(sel.value);
      this.#enterApp();
    });
  }

  async #loadExistingSessions() {
    const sel = this.querySelector('#existing-sessions');
    try {
      const res = await apiGet('/sessions');
      const sessions = res.ok ? res.data : [];
      sel.innerHTML = sessions.length
        ? '<option value="">— select —</option>' +
          sessions.map(s =>
            `<option value="${s.codeword}">${s.codeword} — ${s.feature} (${s.phase})</option>`
          ).join('')
        : '<option value="">No sessions found</option>';
    } catch {
      sel.innerHTML = '<option value="">Failed to load</option>';
    }
  }

  async #autoRestore() {
    if (!store.codeword) return;
    const res = await apiGet(`/session/${store.codeword}/state`).catch(() => null);
    if (res?.ok) {
      this.#enterApp();
    } else {
      location.hash = '';
      store.codeword = null;
    }
  }

  #enterApp() {
    this.dispatchEvent(new CustomEvent('session-ready', { bubbles: true }));
  }
}

customElements.define('setup-screen', SetupScreen);
