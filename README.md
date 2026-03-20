# Feature Planner

**Turn multiple Claude Code agents into a coordinated team.**

Multiple Claude Code agents working on the same feature will step on each other — conflicting designs, duplicated work, assumptions that don't align. Feature Planner solves this by making agents *talk to each other* before they touch code.

A human facilitator creates a session, shares a codeword, and an AI coordinator takes over: it interviews each agent about their domain, surfaces conflicts between their approaches, negotiates API contracts, and synthesizes everything into a structured plan. Only when the facilitator is satisfied does it flip the switch and release agents to implement — each with a clear, non-overlapping task list.

The mere human decides when the plan is complete and the coding coordinatation can start.

## What happens in a session

```
┌─────────────────────────────────────────────────────────────────┐
│  FACILITATOR (you)                                              │
│  Opens web UI → creates session → gets codeword "swift-falcon"  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              shares codeword with agents
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                  ▼
   ┌───────────┐    ┌───────────┐     ┌───────────┐
   │  Agent 1  │    │  Agent 2  │     │  Agent 3  │
   │ "backend" │    │ "frontend"│     │  "auth"   │
   └─────┬─────┘    └─────┬─────┘     └─────┬─────┘
         │                │                  │
         │     join_session(codeword, role)   │
         │                │                  │
         └────────────────┼──────────────────┘
                          ▼
              ┌───────────────────────┐
              │   AI COORDINATOR      │
              │   (runs in browser)   │
              │                       │
              │  • Interviews agents  │
              │  • Flags conflicts    │
              │  • Negotiates APIs    │
              │  • Writes the plan    │
              └───────────┬───────────┘
                          │
                    ┌─────┴─────┐
                    ▼           ▼
              ┏━━━━━━━━━━┓  PLANNING PHASE
              ┃   PLAN   ┃  All messages prefixed:
              ┃ overview  ┃  "DO NOT WRITE CODE"
              ┃ + per-role┃
              ┗━━━━━━━━━━┛
                    │
             facilitator approves
                    │
                    ▼
            IMPLEMENTING PHASE
            Each agent gets:
            overview + their tasks only
```

The coordinator is a Claude instance running an **agentic tool loop** directly in the browser — it calls `wait_for_replies` to ask agents targeted questions and blocks until they respond, calls `update_plan` to build the design doc in real time, and only hands off to implementation when the plan is solid.

## The interesting parts

**Agents talk through the server, not through files.** The MCP server acts as a message bus — agents send and receive messages by role, ask the coordinator blocking questions, and get their plan section when implementation starts. No shared files, no merge conflicts during planning.

**Phase enforcement is automatic.** During planning, every message an agent receives is prefixed with `[PLAN MODE — DO NOT WRITE CODE]`. The moment the facilitator ends planning, agents get their task assignments and the prefix disappears.

**The coordinator blocks on agent input.** `wait_for_replies` sends a question to specific agents and holds the HTTP connection open (up to 2 minutes) until all of them respond. This means the coordinator can run a structured interview — ask backend about data models, wait, ask frontend about state management, wait, then synthesize both answers — all in a single agentic loop.

**One server, unlimited sessions.** Sessions are identified by random codewords (`swift-falcon`, `brave-otter`). A single running instance handles all your projects simultaneously.

## Quick start

```bash
npm install
npm run build
npm start          # http://localhost:3000
```

### Add to Claude Code

The MCP server uses Streamable HTTP — no stdio process, just a URL:

```bash
claude mcp add -s project feature-planner -t http -- http://localhost:3000/mcp
```

Or add it manually to `~/.claude/settings.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "feature-planner": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Start a session

1. Open `http://localhost:3000` — enter a feature name and your Anthropic API key
2. Copy the codeword from the header
3. In each Claude Code agent, say: *"Use the MCP tool join_session with codeword `swift-falcon` and role `backend`"*
4. The coordinator starts interviewing agents as soon as they join
5. Watch the discussion unfold in the web UI, nudge the coordinator if needed
6. Click **End Planning** when the plan looks good — agents start implementing

## MCP tools (agent-facing)

| Tool | What it does |
|---|---|
| `join_session` | Join with codeword + role label. Returns phase, feature, and who else is in the session. |
| `send_message` | Send to a specific role or `all`. |
| `get_messages` | Long-poll for messages addressed to your role (20s timeout). |
| `get_session_state` | Full snapshot: phase, plan, roles, all messages. |
| `get_my_plan` | Your plan section + the shared overview. |
| `ask_coordinator` | Blocking question to the coordinator — waits up to 2 min for an answer. |
| `wait_for_replies` | Send to multiple roles, block until all reply. |

## Architecture

One Express server, two interfaces on the same port:

- **`/`** — Single-page web UI. The coordinator Claude runs as a tool-use loop in the browser, calling the Anthropic API through a local proxy (`/proxy/claude`) to avoid CORS.
- **`/mcp`** — Streamable HTTP MCP endpoint. Each agent gets its own MCP session; all share the same in-memory session store.

Sessions persist to `data/sessions.json` and survive server restarts. API keys stay in the browser's localStorage and never touch disk on the server.

## Configuration

| Option | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |

The coordinator runs Claude Sonnet via the Anthropic API. You provide the key in the web UI — it's stored in your browser only.
