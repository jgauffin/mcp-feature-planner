// ── Bootstrap ──────────────────────────────────────────────────
// Loads web components and wires up the top-level screen transitions.

import { store } from './lib/store.js';
import './components/setup-screen.js';
import './components/app-header.js';
import './components/chat-panel.js';
import './components/plan-sidebar.js';

// Markdown config
marked.setOptions({ breaks: true, gfm: true });

// Listen for the setup screen signaling that a session is ready
document.addEventListener('session-ready', () => {
  document.querySelector('setup-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  store.loadState();
  store.startPolling();
});
