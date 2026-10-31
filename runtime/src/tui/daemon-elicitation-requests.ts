/**
 * The daemon elicitations this client shows, by occurrence: the request
 * event's own id, the same in live delivery and in replay. Only a daemon that
 * advertises `elicitation.pending` names requests this way; with an older
 * daemon the TUI bridges elicitations as before and keeps no state here.
 *
 * The daemon is the authority on what is pending:
 * - `elicitation_closed` names the occurrence that stopped being pending.
 * - `elicitation.pending` returns every pending occurrence and the event
 *   sequence the set is current at. A request at or below that sequence that
 *   is not in the set is no longer pending, so it is never shown, and a shown
 *   prompt it lists as not pending is closed.
 *
 * An answer is kept until the daemon takes it or closes its request: if
 * sending fails, the next reconcile sends it again while the request is still
 * pending. Answered and closed occurrences are remembered (a request delivered
 * again never reopens) until a snapshot shows them settled below its
 * sequence, after which the sequence rule covers them.
 */

interface Prompt {
  readonly controller: AbortController;
  readonly sequence: number | undefined;
}

interface Answer {
  readonly sequence: number | undefined;
  readonly send: () => Promise<void>;
  sending: boolean;
}

export type DaemonElicitationDelivery =
  | { readonly status: "delivered" }
  /** The prompt was closed before the answer could be sent. */
  | { readonly status: "closed" }
  /** Not sent; it is retried by the next reconcile that finds it pending. */
  | { readonly status: "failed"; readonly error: unknown };

export class DaemonElicitationRequests {
  readonly #shown = new Map<string, Prompt>();
  readonly #answers = new Map<string, Answer>();
  /** Answered and taken, or closed: occurrence id to its request sequence. */
  readonly #settled = new Map<string, number | undefined>();
  #asOfSequence: number | undefined;
  #pendingAtSnapshot: ReadonlySet<string> = new Set();
  #ended = false;

  /**
   * Returns the signal for a request to show, or undefined when it must not
   * be shown: it is shown or being answered already, it was answered or
   * closed, or the last snapshot proves it is no longer pending.
   */
  begin(occurrenceId: string, sequence: number | undefined): AbortController | undefined {
    if (this.#ended) return undefined;
    if (
      this.#shown.has(occurrenceId) ||
      this.#answers.has(occurrenceId) ||
      this.#settled.has(occurrenceId) ||
      this.#settledBySnapshot(occurrenceId, sequence)
    ) {
      return undefined;
    }
    const controller = new AbortController();
    this.#shown.set(occurrenceId, { controller, sequence });
    return controller;
  }

  /**
   * This client answered the prompt `controller` belongs to: send it, and
   * keep it until the daemon takes it or closes the request.
   */
  async deliver(
    occurrenceId: string,
    controller: AbortController,
    send: () => Promise<void>,
  ): Promise<DaemonElicitationDelivery> {
    const prompt = this.#shown.get(occurrenceId);
    if (prompt?.controller !== controller || controller.signal.aborted) {
      return { status: "closed" };
    }
    this.#shown.delete(occurrenceId);
    const answer: Answer = { sequence: prompt.sequence, send, sending: false };
    this.#answers.set(occurrenceId, answer);
    const error = await this.#send(occurrenceId, answer);
    return error === undefined ? { status: "delivered" } : { status: "failed", error };
  }

  /** The daemon closed the request: close its prompt and stop any retry. */
  close(occurrenceId: string, sequence: number | undefined): boolean {
    const prompt = this.#shown.get(occurrenceId);
    const answer = this.#answers.get(occurrenceId);
    this.#shown.delete(occurrenceId);
    this.#answers.delete(occurrenceId);
    this.#settled.set(
      occurrenceId,
      sequence ?? prompt?.sequence ?? answer?.sequence,
    );
    prompt?.controller.abort();
    return prompt !== undefined;
  }

  /**
   * Applies an authoritative pending set taken at `asOfSequence`. Closes
   * shown prompts it proves settled, settles answers the daemon no longer
   * waits for, prunes records the sequence rule now covers, and returns the
   * answers to send again because their requests are still pending.
   */
  reconcile(asOfSequence: number, pending: ReadonlySet<string>): readonly string[] {
    if (this.#ended) return [];
    // A snapshot older than one already applied says nothing new.
    if (this.#asOfSequence !== undefined && asOfSequence < this.#asOfSequence) return [];
    this.#asOfSequence = asOfSequence;
    this.#pendingAtSnapshot = new Set(pending);
    const settled = (id: string, sequence: number | undefined): boolean =>
      !pending.has(id) && sequence !== undefined && sequence <= asOfSequence;
    for (const [id, prompt] of this.#shown) {
      if (!settled(id, prompt.sequence)) continue;
      this.#shown.delete(id);
      this.#settled.set(id, prompt.sequence);
      prompt.controller.abort();
    }
    const resend: string[] = [];
    for (const [id, answer] of this.#answers) {
      if (answer.sending) continue;
      if (pending.has(id)) {
        resend.push(id);
      } else if (settled(id, answer.sequence)) {
        this.#answers.delete(id);
        this.#settled.set(id, answer.sequence);
      }
    }
    for (const [id, sequence] of this.#settled) {
      if (settled(id, sequence)) this.#settled.delete(id);
    }
    return resend;
  }

  /** Sends a kept answer again. Returns the error when it failed again. */
  async resend(occurrenceId: string): Promise<unknown> {
    const answer = this.#answers.get(occurrenceId);
    if (answer === undefined || answer.sending) return undefined;
    return this.#send(occurrenceId, answer);
  }

  /** Answers not yet taken by the daemon (for tests and diagnostics). */
  get unacknowledged(): readonly string[] {
    return [...this.#answers.keys()];
  }

  /** Settled occurrences still remembered (for tests and diagnostics). */
  get remembered(): number {
    return this.#settled.size;
  }

  /** The event stream ended: no answer can reach the daemon through it. */
  closeAll(): void {
    this.#ended = true;
    for (const prompt of this.#shown.values()) prompt.controller.abort();
    this.#shown.clear();
    this.#answers.clear();
  }

  #settledBySnapshot(occurrenceId: string, sequence: number | undefined): boolean {
    return (
      this.#asOfSequence !== undefined &&
      sequence !== undefined &&
      sequence <= this.#asOfSequence &&
      !this.#pendingAtSnapshot.has(occurrenceId)
    );
  }

  async #send(occurrenceId: string, answer: Answer): Promise<unknown> {
    answer.sending = true;
    try {
      await answer.send();
    } catch (error) {
      return error;
    } finally {
      answer.sending = false;
    }
    if (this.#answers.get(occurrenceId) === answer) {
      this.#answers.delete(occurrenceId);
      this.#settled.set(occurrenceId, answer.sequence);
    }
    return undefined;
  }
}
