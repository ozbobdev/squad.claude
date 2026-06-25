import Anthropic from '@anthropic-ai/sdk';
import type {
  SquadSession,
  SquadSessionConfig,
  SquadMessageOptions,
  SquadSessionEventType,
  SquadSessionEventHandler,
  SquadSessionEvent,
} from './types.js';

export class AnthropicSessionAdapter implements SquadSession {
  readonly sessionId: string;
  private anthropic: Anthropic;
  private model: string;
  private systemPrompt: string;
  private messages: Anthropic.MessageParam[] = [];
  private listeners: Map<string, Set<SquadSessionEventHandler>> = new Map();
  private activeStream: { controller: AbortController } | null = null;
  private tools: Anthropic.Tool[];

  constructor(config: SquadSessionConfig) {
    const apiKey = config.provider?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
    this.anthropic = new Anthropic({ apiKey });
    this.sessionId = config.sessionId ?? crypto.randomUUID();
    this.model = config.model ?? 'claude-sonnet-4-6';

    const sm = config.systemMessage;
    const defaultPrompt = 'You are a helpful software engineering assistant.';
    if (sm?.mode === 'replace') {
      this.systemPrompt = sm.content;
    } else {
      this.systemPrompt = sm?.content ? `${defaultPrompt}\n\n${sm.content}` : defaultPrompt;
    }

    this.tools = (config.tools ?? []).map(tool => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: (tool.parameters ?? { type: 'object' }) as Anthropic.Tool['input_schema'],
    }));
  }

  on(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(handler);
  }

  off(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    this.listeners.get(eventType)?.delete(handler);
  }

  private emit(eventType: string, payload: Record<string, unknown>): void {
    const event: SquadSessionEvent = { type: eventType, ...payload };
    this.listeners.get(eventType)?.forEach(handler => handler(event));
  }

  async sendMessage(options: SquadMessageOptions): Promise<void> {
    if (options.prompt.startsWith('__tool_result__:')) {
      const json = options.prompt.slice('__tool_result__:'.length);
      const toolResult = JSON.parse(json) as { toolUseId: string; content: string };
      this.messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolResult.toolUseId,
          content: toolResult.content,
        }],
      });
    } else {
      this.messages.push({ role: 'user', content: options.prompt });
    }

    this.emit('turn_start', {});

    let fullText = '';

    try {
      const streamParams: Parameters<typeof this.anthropic.messages.stream>[0] = {
        model: this.model,
        max_tokens: 8096,
        system: this.systemPrompt,
        messages: this.messages,
        ...(this.tools.length > 0 ? { tools: this.tools } : {}),
      };

      const stream = this.anthropic.messages.stream(streamParams);
      this.activeStream = stream as unknown as { controller: AbortController };

      stream.on('text', (text: string) => {
        fullText += text;
        this.emit('message_delta', { delta: text });
      });

      const message = await stream.finalMessage();
      this.activeStream = null;

      const textBlocks = message.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text'
      );
      if (textBlocks.length > 0 && !fullText) {
        fullText = textBlocks.map(b => b.text).join('');
      }

      this.emit('message', { content: fullText });

      this.emit('usage', {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        model: this.model,
      });

      this.messages.push({ role: 'assistant', content: message.content as Anthropic.MessageParam['content'] });

      const toolUseBlocks = message.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );
      for (const block of toolUseBlocks) {
        this.emit('tool_call', {
          type: 'tool_call',
          toolName: block.name,
          toolInput: block.input,
          toolUseId: block.id,
        });
      }

      this.emit('turn_end', {});
      this.emit('idle', {});
    } catch (err) {
      this.activeStream = null;
      this.emit('error', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async sendAndWait(options: SquadMessageOptions, timeout = 60000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let result = '';

      const onMessage = (event: SquadSessionEvent) => {
        if (typeof event['content'] === 'string') {
          result = event['content'];
        }
      };

      const onIdle = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.off('message', onMessage);
          this.off('idle', onIdle);
          resolve(result);
        }
      };

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.off('message', onMessage);
          this.off('idle', onIdle);
          reject(new Error('timeout'));
        }
      }, timeout);

      this.on('message', onMessage);
      this.on('idle', onIdle);

      this.sendMessage(options).catch(err => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.off('message', onMessage);
          this.off('idle', onIdle);
          reject(err);
        }
      });
    });
  }

  async abort(): Promise<void> {
    if (this.activeStream) {
      this.activeStream.controller.abort();
      this.activeStream = null;
    }
    this.emit('idle', {});
  }

  async getMessages(): Promise<unknown[]> {
    return this.messages;
  }

  async close(): Promise<void> {
    await this.abort();
    this.messages = [];
    this.listeners.clear();
  }
}

export function checkAnthropicAuth(): { ok: boolean; message: string; key?: string } {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) {
    return {
      ok: false,
      message:
        'ANTHROPIC_API_KEY is not set.\n' +
        'PowerShell : $env:ANTHROPIC_API_KEY="sk-ant-..."\n' +
        'CMD        : set ANTHROPIC_API_KEY=sk-ant-...',
    };
  }
  return { ok: true, message: 'ANTHROPIC_API_KEY found.' };
}
