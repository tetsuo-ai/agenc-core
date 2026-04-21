import type { StdoutMessage } from "../entrypoints/sdk/controlTypes.js";
import { RetryableError, SerialBatchEventUploader } from "./serial-batch-uploader.js";
import { WebSocketTransport, convertWsUrlToPostUrl, type WebSocketTransportOptions } from "./ws-duplex.js";

const BATCH_FLUSH_INTERVAL_MS = 100;
const POST_TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 3_000;

export interface HybridTransportOptions extends WebSocketTransportOptions {
  readonly maxConsecutiveFailures?: number;
  readonly onBatchDropped?: (batchSize: number, failures: number) => void;
  readonly fetchImpl?: typeof fetch;
}

export class HybridTransport extends WebSocketTransport {
  private readonly postUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly uploader: SerialBatchEventUploader<StdoutMessage>;
  private streamEventBuffer: StdoutMessage[] = [];
  private streamEventTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    options: HybridTransportOptions = {},
  ) {
    super(url, headers, sessionId, refreshHeaders, options);
    this.postUrl = convertWsUrlToPostUrl(url);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.uploader = new SerialBatchEventUploader<StdoutMessage>({
      maxBatchSize: 500,
      maxQueueSize: 100_000,
      baseDelayMs: 500,
      maxDelayMs: 8_000,
      jitterMs: 1_000,
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      onBatchDropped: options.onBatchDropped,
      send: async (batch) => this.postOnce(batch, headers, refreshHeaders),
    });
  }

  override async write(message: StdoutMessage): Promise<void> {
    if (isStreamEvent(message)) {
      this.streamEventBuffer.push(message);
      if (this.streamEventTimer === null) {
        this.streamEventTimer = setTimeout(() => {
          this.streamEventTimer = null;
          void this.uploader.enqueue(this.takeStreamEvents());
        }, BATCH_FLUSH_INTERVAL_MS);
      }
      return;
    }

    await this.uploader.enqueue([...this.takeStreamEvents(), message]);
    await this.uploader.flush();
  }

  async writeBatch(messages: StdoutMessage[]): Promise<void> {
    await this.uploader.enqueue([...this.takeStreamEvents(), ...messages]);
    await this.uploader.flush();
  }

  flush(): Promise<void> {
    void this.uploader.enqueue(this.takeStreamEvents());
    return this.uploader.flush();
  }

  get droppedBatchCount(): number {
    return this.uploader.droppedBatchCount;
  }

  override close(): void {
    if (this.streamEventTimer !== null) {
      clearTimeout(this.streamEventTimer);
      this.streamEventTimer = null;
    }
    this.streamEventBuffer = [];
    const uploader = this.uploader;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    void Promise.race([
      uploader.flush(),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, CLOSE_GRACE_MS);
      }),
    ]).finally(() => {
      if (graceTimer !== null) clearTimeout(graceTimer);
      uploader.close();
    });
    super.close();
  }

  private takeStreamEvents(): StdoutMessage[] {
    if (this.streamEventTimer !== null) {
      clearTimeout(this.streamEventTimer);
      this.streamEventTimer = null;
    }
    const buffered = this.streamEventBuffer;
    this.streamEventBuffer = [];
    return buffered;
  }

  private async postOnce(
    events: StdoutMessage[],
    headers: Record<string, string>,
    refreshHeaders?: () => Record<string, string>,
  ): Promise<void> {
    const mergedHeaders = {
      ...headers,
      ...(refreshHeaders?.() ?? {}),
      "Content-Type": "application/json",
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.postUrl, {
        method: "POST",
        headers: mergedHeaders,
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
      if (response.status >= 200 && response.status < 300) {
        return;
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return;
      }
      throw new RetryableError(`POST failed with ${response.status}`);
    } catch (error) {
      if (error instanceof RetryableError) {
        throw error;
      }
      throw new RetryableError("POST failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

function isStreamEvent(message: StdoutMessage): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "stream_event"
  );
}

