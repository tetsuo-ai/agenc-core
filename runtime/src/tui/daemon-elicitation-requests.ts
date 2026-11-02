/**
 * The daemon elicitations this client shows, by occurrence: the request
 * event's own id, the same in live delivery and in replay. Only a daemon that
 * advertises `elicitation.pending` names requests this way; with an older
 * daemon the TUI bridges elicitations as before and keeps no state here.
 *
 * The daemon is the authority on what is pending:
 * - `elicitation_closed` names the occurrence that stopped being pending.
 * - `elicitation.pending` returns every pending occurrence and the event
 *   sequence the set is current at. An occurrence it does not list is no
 *   longer pending when this client learned of it before asking (the daemon
 *   had published it by then), or when its sequence is at or below that
 *   sequence. Such a request is never shown, and a shown prompt is closed.
 *
 * An answer is kept until the daemon takes it or closes its request: if
 * sending fails, the next reconcile sends it again while the request is still
 * pending. Answered and closed occurrences are remembered (a request delivered
 * again never reopens) until a pending set shows them settled at or below its
 * sequence. Every request is checked against a fresh pending set before
 * display, so even unjournaled settlements can be pruned without reopening
 * an old replay.
 */

interface Known {
  readonly sequence: number | undefined;
  /** When this client learned of the occurrence, on the registry's clock. */
  readonly learned: number;
}

interface Prompt extends Known {
  readonly controller: AbortController;
}

interface Answer extends Known {
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
  /** Answered and taken, or closed. */
  readonly #settled = new Map<string, Known>();
  #clock = 0;
  #asOfSequence: number | undefined;
  #pendingAtSnapshot: ReadonlySet<string> = new Set();
  #ended = false;

  /**
   * Returns the signal for a request to show, or undefined when it must not
   * be shown: it is shown or being answered already, it was answered or
   * closed, or it is absent from the fresh pending set the bridge requested.
   */
  begin(occurrenceId: string, sequence: number | undefined): AbortController | undefined {
    if (this.#ended) return undefined;
    if (
      this.#shown.has(occurrenceId) ||
      this.#answers.has(occurrenceId) ||
      this.#settled.has(occurrenceId) ||
      (this.#asOfSequence !== undefined && !this.#pendingAtSnapshot.has(occurrenceId))
    ) {
      return undefined;
    }
    const controller = new AbortController();
    this.#shown.set(occurrenceId, { controller, sequence, learned: this.#tick() });
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
    const answer: Answer = {
      sequence: prompt.sequence,
      learned: prompt.learned,
      send,
      sending: false,
    };
    this.#answers.set(occurrenceId, answer);
    const error = await this.#send(occurrenceId, answer);
    return error === undefined ? { status: "delivered" } : { status: "failed", error };
  }

  /** The daemon closed the request: close its prompt and stop any retry. */
  close(occurrenceId: string, sequence: number | undefined): boolean {
    const prompt = this.#shown.get(occurrenceId);
    const known = prompt ?? this.#answers.get(occurrenceId) ?? this.#settled.get(occurrenceId);
    this.#shown.delete(occurrenceId);
    this.#answers.delete(occurrenceId);
    this.#settled.set(occurrenceId, {
      sequence: sequence ?? known?.sequence,
      learned: known?.learned ?? this.#tick(),
    });
    prompt?.controller.abort();
    return prompt !== undefined;
  }

  /**
   * The point on this registry's clock to pass to `reconcile` with the
   * pending set requested now: everything learned until then was published
   * before the daemon reads its set.
   */
  mark(): number {
    return this.#clock;
  }

  /**
   * Applies the pending set the daemon took at `asOfSequence`, requested at
   * `mark`. Closes shown prompts it proves settled, settles answers the daemon
   * no longer waits for, prunes records the sequence rule now covers, and
   * returns the answers to send again because their requests are still
   * pending. The latest set wins, also one with a lower sequence (a daemon
   * that restarted on a journal without its last events).
   */
  reconcile(mark: number, asOfSequence: number, pending: ReadonlySet<string>): readonly string[] {
    if (this.#ended) return [];
    this.#asOfSequence = asOfSequence;
    this.#pendingAtSnapshot = new Set(pending);
    const settled = (id: string, known: Known): boolean =>
      !pending.has(id) &&
      (known.learned <= mark || (known.sequence !== undefined && known.sequence <= asOfSequence));
    for (const [id, prompt] of this.#shown) {
      if (!settled(id, prompt)) continue;
      this.#shown.delete(id);
      this.#settled.set(id, { sequence: prompt.sequence, learned: prompt.learned });
      prompt.controller.abort();
    }
    const resend: string[] = [];
    for (const [id, answer] of this.#answers) {
      if (answer.sending) continue;
      if (pending.has(id)) {
        resend.push(id);
      } else if (settled(id, answer)) {
        this.#answers.delete(id);
        this.#settled.set(id, { sequence: answer.sequence, learned: answer.learned });
      }
    }
    for (const [id, known] of this.#settled) {
      if (settled(id, known)) this.#settled.delete(id);
    }
    return resend;
  }

  /** Every request is checked against a fresh set before the bridge shows it. */
  isPending(occurrenceId: string): boolean {
    return this.#pendingAtSnapshot.has(occurrenceId);
  }

  /** The daemon definitively lost this runtime. Future snapshots can start anew. */
  reset(): void {
    for (const prompt of this.#shown.values()) prompt.controller.abort();
    this.#shown.clear();
    this.#answers.clear();
    this.#settled.clear();
    this.#pendingAtSnapshot = new Set();
    this.#asOfSequence = undefined;
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
    this.reset();
  }

  #tick(): number {
    this.#clock += 1;
    return this.#clock;
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
      this.#settled.set(occurrenceId, { sequence: answer.sequence, learned: answer.learned });
    }
    return undefined;
  }
}
