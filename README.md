# Feature Planner

Multiple Claude Code agents working on the same feature often step on each other — conflicting designs, duplicated work, or assumptions that don't align. Feature Planner fixes this by enforcing a **planning phase** where agents discuss and agree on an approach *before* anyone writes code.

A human facilitator creates a session, shares a codeword with each agent, and an AI coordinator guides the discussion: asking clarifying questions, surfacing conflicts, and synthesizing decisions into a design doc. Only once the group reaches agreement does the coordinator unlock the implementation phase.

## How it works

Feature Planner runs a single HTTP server that serves both the web UI and the MCP endpoint:

- **`/mcp`** — Streamable HTTP transport for Claude Code agents. Each agent gets its own MCP session; all share the same in-memory store. Multiple agents connect simultaneously.
- **`/`** — Web UI where the human facilitator watches the discussion, nudges the coordinator, and manages phase transitions.

Sessions are separated by **codeword**, so one server instance can handle multiple projects at once.

### Flow

1. The facilitator opens `http://localhost:3000`, creates a session (feature name + Anthropic API key), and receives a **codeword** (e.g. `swift-falcon`).
2. Each Claude Code agent calls `join_session` with the codeword and a role label (e.g. `backend`, `frontend-react`).
3. Agents enter a `get_messages` loop. During the **planning phase**, all messages are prefixed with a reminder not to write code.
4. The AI coordinator (running in the web UI) routes questions, flags disagreements, and updates the design doc.
5. When the facilitator is satisfied, the coordinator transitions to the **implementing phase** — agents receive clearance to start coding.

### MCP tools

| Tool | Description |
|---|---|
| `join_session` | Join a session by codeword and role. Returns phase, feature name, and roster. |
| `send_message` | Send a message to a specific role or `all`. |
| `get_messages` | Long-poll (up to 20 s) for new messages addressed to your role. |
| `get_session_state` | Retrieve full session state: phase, design doc, roles, messages. |
| `ask_coordinator` | Send a blocking question to the coordinator (up to 2 min wait). |

## Setup

```bash
npm install
npm run build
npm start
```

The server starts at `http://localhost:3000`. Set the `PORT` environment variable to change the port.

### Add to Claude Code

Since the MCP server uses Streamable HTTP, you only need to point Claude Code at the URL — no stdio process needed:

```json
{
  "mcpServers": {
    "feature-planner": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Add this to `~/.claude/settings.json` (global) or `.mcp.json` (per-project). Because the server is shared and sessions are separated by codeword, a single running instance works across all your projects.

## Configuration

| Option | Default | Description |
|---|---|---|
| `PORT` env var | `3000` | HTTP server port |

The coordinator UI uses the **Anthropic API** (Claude) to power the AI coordinator. You'll be prompted for your Anthropic API key when creating a session in the web UI. The key is stored in your browser's localStorage and never persisted on the server.

Sessions and messages are stored in memory — restarting the server clears all state.
