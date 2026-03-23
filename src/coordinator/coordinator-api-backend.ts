import { ProxyAgent } from 'undici';
import type { CoordinatorBackend, CoordinatorToolDef } from './coordinator-backend.js';
import type { CoordinatorEmitter } from '../coordinator.js';

/**
 * Coordinator backend that calls the Anthropic Messages API directly.
 *
 * The API is stateless — every request must include the full system prompt +
 * history. To reduce cost we use prompt caching: the system prompt and early
 * history entries are marked with cache_control so repeated prefixes are
 * charged at reduced rate.
 */
export class AnthropicApiBackend implements CoordinatorBackend {
  constructor(private apiKey: string) {}

  async runLoop(
    systemPrompt: string,
    history: Array<{ role: string; content: unknown }>,
    tools: CoordinatorToolDef[],
    executeTool: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<string>,
    emit: CoordinatorEmitter,
    signal: AbortSignal,
    _plannerSessionId?: string,
  ): Promise<void> {
    emit.thinking('Coordinator is thinking\u2026');

    // System prompt with cache_control to enable prompt caching
    const system = [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];

    while (true) {
      if (signal.aborted) {
        emit.error('Coordinator was cancelled.');
        break;
      }

      const proxyUrl =
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy;

      const fetchOptions: Record<string, unknown> = {
        method: 'POST',
        signal,
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system,
          messages: history,
          tools,
        }),
      };

      if (proxyUrl) {
        fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
      }

      let data: {
        content: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        stop_reason: string;
      };

      try {
        const upstream = await fetch(
          'https://api.anthropic.com/v1/messages',
          fetchOptions as RequestInit,
        );
        data = (await upstream.json()) as typeof data;

        if (!upstream.ok) {
          emit.error(`Claude API error ${upstream.status}: ${JSON.stringify(data)}`);
          break;
        }
      } catch (e) {
        if (signal.aborted) {
          emit.error('Coordinator was cancelled.');
          break;
        }
        emit.error(`Claude API request failed: ${(e as Error).message}`);
        break;
      }

      history.push({ role: 'assistant', content: data.content });

      // Emit text blocks
      const textBlocks = data.content.filter((b) => b.type === 'text');
      if (textBlocks.length) {
        const fullText = textBlocks.map((b) => b.text).join('\n\n');
        emit.text(fullText);
      }

      const toolUses = data.content.filter((b) => b.type === 'tool_use');
      if (data.stop_reason === 'end_turn' || toolUses.length === 0) {
        break;
      }

      // Update thinking indicator
      const waitingFor = toolUses.find((b) => b.name === 'wait_for_replies');
      if (waitingFor) {
        const roles = ((waitingFor.input?.to as string[]) || []).join(', ');
        emit.thinking(`Waiting for replies from ${roles}\u2026`);
      } else {
        emit.thinking('Coordinator is thinking\u2026');
      }

      // Execute tools
      const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
      for (const b of toolUses) {
        emit.toolStart(b.name!, b.input as Record<string, unknown>);
        if (signal.aborted) break;
        const result = await executeTool(b.name!, b.input as Record<string, unknown>, signal);
        emit.toolResult(b.name!, result);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: b.id!,
          content: result,
        });
      }

      history.push({ role: 'user', content: toolResults });

      emit.thinking('Coordinator is thinking\u2026');
    }
  }
}
