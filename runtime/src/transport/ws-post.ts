import type { StdoutMessage } from "../entrypoints/sdk/controlTypes.js";
import { getSessionIngressAuthHeaders } from "../utils/sessionIngressAuth.js";
import type { HeaderMap } from "./index.js";
import { RetryableError, SerialBatchEventUploader } from "./serial-batch-uploader.js";
import {
  WebSocketTransport,
  convertWsUrlToPostUrl,
  type WebSocketTransportOptions,
} from "./ws-duplex.js";
import { authHeadersOnly } from "./index.js";

// Retained openclaude hybrid ingress seam: WS reads, POST writes.
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
      send: async (batch) => this.postOnce(batch),
    });
  }

  override async write(message: StdoutMessage): Promise<void> {
    this.trackBufferedMessage(message);
    if (isStreamEvent(message)) {
      this.streamEventBuffer.push(message);
      if (!this.streamEventTimer) {
        this.streamEventTimer = setTimeout(
          () => this.flushStreamEvents(),
          BATCH_FLUSH_INTERVAL_MS,
        );
      }
      return;
    }

    await this.uploader.enqueue([...this.takeStreamEvents(), message]);
    return this.uploader.flush();
  }

  async writeBatch(messages: StdoutMessage[]): Promise<void> {
    for (const message of messages) {
      this.trackBufferedMessage(message);
    }
    await this.uploader.enqueue([...this.takeStreamEvents(), ...messages]);
    return this.uploader.flush();
  }

  flush(): Promise<void> {
    void this.uploader.enqueue(this.takeStreamEvents());
    return this.uploader.flush();
  }

  get droppedBatchCount(): number {
    return this.uploader.droppedBatchCount;
  }

  override close(): void {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer);
      this.streamEventTimer = null;
    }
    this.streamEventBuffer = [];

    const uploader = this.uploader;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      uploader.flush(),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, CLOSE_GRACE_MS);
      }),
    ]).finally(() => {
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      uploader.close();
    });

    super.close();
  }

  protected override replayBufferedMessages(lastId = ""): void {
    const replayBatch = this.consumeReplayBufferedMessages(lastId);
    if (replayBatch.length === 0) {
      return;
    }
    void this.uploader.enqueue(replayBatch).then(() => this.uploader.flush());
  }

  private takeStreamEvents(): StdoutMessage[] {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer);
      this.streamEventTimer = null;
    }
    const buffered = this.streamEventBuffer;
    this.streamEventBuffer = [];
    return buffered;
  }

  private flushStreamEvents(): void {
    this.streamEventTimer = null;
    void this.uploader.enqueue(this.takeStreamEvents());
  }

  private async postOnce(events: StdoutMessage[]): Promise<void> {
    const mergedHeaders = this.buildPostHeaders();
    if (mergedHeaders.Cookie) {
      delete mergedHeaders.Authorization;
    }
    if (!mergedHeaders.Authorization && !mergedHeaders.Cookie) {
      return;
    }

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

  private buildPostHeaders(): HeaderMap {
    const refreshedHeaders = this.refreshTransportHeaders();
    const authHeaders =
      authHeadersOnly(refreshedHeaders);
    const resolvedAuthHeaders =
      Object.keys(authHeaders).length > 0
        ? authHeaders
        : authHeadersOnly(getSessionIngressAuthHeaders());
    return {
      ...resolvedAuthHeaders,
      "Content-Type": "application/json",
    };
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
