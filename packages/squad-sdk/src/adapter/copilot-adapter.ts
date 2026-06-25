import type {
  SquadSession,
  SquadMessageOptions,
  SquadSessionEventType,
  SquadSessionEventHandler,
  SquadSessionEvent,
  SquadTool,
} from './types.js';


/**
 * Adapts @github/copilot-sdk CopilotSession to our SquadSession interface.
 * Maps sendMessage() → send(), off() via unsubscribe tracking, close() → destroy().
 *
 * Bug reported by @spboyer (Shayne Boyer) — Codespace environment exposed
 * the unsafe `as unknown as` cast that skipped runtime method mapping.
 */
export class CopilotSessionAdapter implements SquadSession {
  /**
   * Maps Squad short event names → @github/copilot-sdk dotted event names.
   * SDK uses dotted-namespace prefixes (e.g., `assistant.message_delta`),
   * while Squad uses short names (e.g., `message_delta`).
   * Names already in dotted form pass through via the fallback.
   */
  private static readonly EVENT_MAP: Record<string, string> = {
    'message_delta': 'assistant.message_delta',
    'message': 'assistant.message',
    'usage': 'assistant.usage',
    'reasoning_delta': 'assistant.reasoning_delta',
    'reasoning': 'assistant.reasoning',
    'turn_start': 'assistant.turn_start',
    'turn_end': 'assistant.turn_end',
    'intent': 'assistant.intent',
    'idle': 'session.idle',
    'error': 'session.error',
  };

  /** Reverse map: SDK dotted names → Squad short names. */
  private static readonly REVERSE_EVENT_MAP: Record<string, string> = Object.fromEntries(
    Object.entries(CopilotSessionAdapter.EVENT_MAP).map(([k, v]) => [v, k])
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly inner: any;
  private readonly unsubscribers = new Map<SquadSessionEventHandler, Map<string, () => void>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(copilotSession: any) {
    this.inner = copilotSession;
  }

  get sessionId(): string {
    return this.inner.sessionId ?? 'unknown';
  }

  async sendMessage(options: SquadMessageOptions): Promise<void> {
    await this.inner.send(options);
  }

  async sendAndWait(options: SquadMessageOptions, timeout?: number): Promise<unknown> {
    return await this.inner.sendAndWait(options, timeout);
  }

  async abort(): Promise<void> {
    await this.inner.abort();
  }

  async getMessages(): Promise<unknown[]> {
    return await this.inner.getMessages();
  }

  /**
   * Normalizes an SDK event into a SquadSessionEvent.
   * Maps the dotted type back to the Squad short name and
   * flattens `event.data` onto the top-level object so callers
   * can access fields directly (e.g., `event.inputTokens`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static normalizeEvent(sdkEvent: any): SquadSessionEvent {
    const squadType = CopilotSessionAdapter.REVERSE_EVENT_MAP[sdkEvent.type] ?? sdkEvent.type;
    return {
      type: squadType,
      ...(sdkEvent.data ?? {}),
    };
  }

  on(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    const sdkType = CopilotSessionAdapter.EVENT_MAP[eventType] ?? eventType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedHandler = (sdkEvent: any) => {
      handler(CopilotSessionAdapter.normalizeEvent(sdkEvent));
    };
    const unsubscribe = this.inner.on(sdkType, wrappedHandler);
    if (!this.unsubscribers.has(handler)) {
      this.unsubscribers.set(handler, new Map());
    }
    this.unsubscribers.get(handler)!.set(eventType, unsubscribe);
  }

  off(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void {
    const handlerMap = this.unsubscribers.get(handler);
    if (handlerMap) {
      const unsubscribe = handlerMap.get(eventType);
      if (unsubscribe) {
        unsubscribe();
        handlerMap.delete(eventType);
      }
      if (handlerMap.size === 0) {
        this.unsubscribers.delete(handler);
      }
    }
  }

  async close(): Promise<void> {
    await this.inner.destroy();
    this.unsubscribers.clear();
  }
}
