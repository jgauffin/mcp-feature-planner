import type { CoordinatorEmitter } from '../coordinator.js';

/**
 * Tool definition used by the coordinator.
 */
export interface CoordinatorToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Abstraction over the LLM that powers the coordinator.
 * Implementations handle the full conversation loop (API calls + tool execution).
 */
export interface CoordinatorBackend {
  /**
   * Run one coordinator turn.
   *
   * @param systemPrompt    - The system prompt (only used on first call; ignored on resume)
   * @param history         - Conversation history (mutated: new entries appended)
   * @param tools           - Tool definitions available to the coordinator
   * @param executeTool     - Callback to execute a tool call and return its result
   * @param emit            - Event emitter for streaming UI updates
   * @param signal          - Abort signal to cancel the loop
   * @param plannerSessionId - Planner session ID (used to track backend conversation state)
   */
  runLoop(
    systemPrompt: string,
    history: Array<{ role: string; content: unknown }>,
    tools: CoordinatorToolDef[],
    executeTool: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<string>,
    emit: CoordinatorEmitter,
    signal: AbortSignal,
    plannerSessionId?: string,
  ): Promise<void>;
}

export type BackendType = 'api' | 'claude-code';
