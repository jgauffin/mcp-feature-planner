import { store } from '../lib/store.js';

class AppHeader extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <header>
        <span class="app-title">Feature Planner</span>
        <span id="codeword-badge" class="codeword-badge" title="Click to copy codeword">&#9000; &mdash;</span>
        <span id="phase-badge" class="phase-badge phase-planning">planning</span>
        <span id="header-roles" class="header-roles"></span>
      </header>
    `;

    this.querySelector('#codeword-badge').addEventListener('click', () => {
      navigator.clipboard.writeText(store.codeword || '');
      const badge = this.querySelector('#codeword-badge');
      const prev = badge.textContent;
      badge.textContent = '\u2713 Copied!';
      setTimeout(() => badge.textContent = prev, 1500);
    });

    store.on('state-changed', () => this.#update());
  }

  #update() {
    if (!store.session) return;
    const badge = this.querySelector('#codeword-badge');
    badge.textContent = `\u2328 ${store.codeword}`;

    const phaseBadge = this.querySelector('#phase-badge');
    phaseBadge.textContent = store.session.phase;
    phaseBadge.className = `phase-badge phase-${store.session.phase}`;

    this.querySelector('#header-roles').textContent =
      store.session.joinedRoles.join(' \u00b7 ');
  }
}

customElements.define('app-header', AppHeader);
