# Rust → TypeScript Translation Conventions

Rules for hand-porting AgenC runtime Rust files to AgenC TypeScript. Pick
once, apply consistently across every hand-port tranche. AgenC runtime source
is read-only reference — we translate, not vendor.

---

## Core primitives

| Rust | TypeScript | Rationale |
|---|---|---|
| `Arc<T>` | plain reference / object identity | JS has GC; no refcount primitive needed |
| `Rc<T>` | plain reference | same as Arc for single-threaded |
| `Mutex<T>` | `AsyncLock<T>` (see §2) | JS has one event loop, but async critical sections still need serialization |
| `RwLock<T>` | `AsyncRwLock<T>` (see §2) | read-concurrent, write-exclusive |
| `Arc<Mutex<T>>` | shared instance of `AsyncLock<T>` | combine identity sharing + locking |
| `Arc<RwLock<T>>` | shared instance of `AsyncRwLock<T>` | same |
| `Option<T>` | `T \| null` (prefer `null` over `undefined`) | `null` is the deliberate "absent" marker; `undefined` is for "not yet set" |
| `Result<T, E>` | `throw E` on error path, `return T` on success | TypeScript's exception model is primary; only use Result wrapper if composing many fallible calls |
| `Vec<T>` | `T[]` | direct |
| `HashMap<K, V>` | `Map<K, V>` | keep `Map` for non-string keys; use plain object only for string-keyed lookups |
| `HashSet<T>` | `Set<T>` | direct |
| `BTreeMap<K, V>` | custom sorted array or `Map` + sort on iteration | `Map` preserves insertion order; add explicit sort when needed |
| `&str` / `String` | `string` | JS strings are immutable; no lifetime distinction |
| `&[T]` / `Vec<T>` | `readonly T[]` / `T[]` | use `readonly` for borrow-style signatures |
| `impl Trait` | `interface Trait` + class implementing it | direct structural match |
| `dyn Trait` (trait object) | `Trait` (interface) | TS interfaces are duck-typed at runtime |
| `Box<T>` | plain reference | heap allocation is default in JS |

---

## Concurrency primitives

All live in `runtime/src/utils/`:

### AsyncLock

```ts
// runtime/src/utils/async-lock.ts
export class AsyncLock<T> {
  private value: T;
  private chain: Promise<void> = Promise.resolve();

  constructor(initial: T) { this.value = initial; }

  async with<R>(fn: (value: T) => Promise<R>): Promise<R> {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const previous = this.chain;
    this.chain = gate;
    await previous;
    try {
      return await fn(this.value);
    } finally {
      release();
    }
  }
}
```

**Rust → TS:**

```rust
let state = Arc::new(Mutex::new(SessionState::new()));
let guard = state.lock().await;
guard.history.push(msg);
```

```ts
const state = new AsyncLock<SessionState>(new SessionState());
await state.with(async (s) => { s.history.push(msg); });
```

### AsyncRwLock

```ts
// runtime/src/utils/async-rwlock.ts
export class AsyncRwLock<T> {
  private value: T;
  private readers = 0;
  private writerChain: Promise<void> = Promise.resolve();
  private pendingReadGate: Promise<void> = Promise.resolve();

  async withRead<R>(fn: (value: T) => Promise<R>): Promise<R> {
    await this.pendingReadGate; // wait if a writer is queued
    this.readers++;
    try {
      return await fn(this.value);
    } finally {
      this.readers--;
    }
  }

  async withWrite<R>(fn: (value: T) => Promise<R>): Promise<R> {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const previous = this.writerChain;
    this.writerChain = gate;
    this.pendingReadGate = gate;
    await previous;
    // drain readers
    while (this.readers > 0) { await new Promise(r => setImmediate(r)); }
    try {
      return await fn(this.value);
    } finally {
      release();
    }
  }
}
```

**Rust → TS:**

```rust
let lock = Arc::new(RwLock::new(()));
// in parallel path
let _guard = lock.read().await;
// in serial path
let _guard = lock.write().await;
```

```ts
const lock = new AsyncRwLock<void>(undefined as any);
// parallel path
await lock.withRead(async () => dispatch());
// serial path
await lock.withWrite(async () => dispatch());
```

### AsyncQueue (for `tokio::sync::mpsc`)

```ts
// runtime/src/utils/async-queue.ts
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T) => void> = [];
  private closed = false;

  send(item: T): void {
    if (this.closed) throw new Error('queue closed');
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.push(item);
  }

  async recv(): Promise<T | null> {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (this.closed) return null;
    return new Promise<T>(resolve => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters) w(null as any);
    this.waiters.length = 0;
  }

  async *stream(): AsyncIterable<T> {
    while (true) {
      const item = await this.recv();
      if (item === null) return;
      yield item;
    }
  }
}
```

### BehaviorSubject (for `tokio::sync::watch::channel`)

```ts
// runtime/src/utils/behavior-subject.ts
type Listener<T> = (value: T) => void;

export class BehaviorSubject<T> {
  private currentValue: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) { this.currentValue = initial; }

  get value(): T { return this.currentValue; }

  next(value: T): void {
    this.currentValue = value;
    for (const l of this.listeners) l(value);
  }

  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    fn(this.currentValue); // replay current
    return () => this.listeners.delete(fn);
  }

  async *changes(): AsyncIterable<T> {
    let resolve!: (v: T) => void;
    let next = new Promise<T>(r => { resolve = r; });
    const unsub = this.subscribe(v => {
      resolve(v);
      next = new Promise<T>(r => { resolve = r; });
    });
    try {
      while (true) yield await next;
    } finally {
      unsub();
    }
  }
}
```

**Rust → TS:**

```rust
let (tx, rx) = watch::channel(AgentStatus::Idle);
tx.send(AgentStatus::Running)?;
let current = rx.borrow().clone();
rx.changed().await?;
```

```ts
const status = new BehaviorSubject<AgentStatus>(AgentStatus.Idle);
status.next(AgentStatus.Running);
const current = status.value;
for await (const v of status.changes()) { /* react */ }
```

### Notify (`tokio::sync::Notify`)

Use `AsyncQueue<void>` or a simple resolve-once promise pair.

---

## Enums and pattern matching

### Rust enum variants → TS discriminated unions

**Rust:**

```rust
pub enum EventMsg {
    TurnStarted(TurnStartedEvent),
    TurnComplete(TurnCompleteEvent),
    AgentMessage(AgentMessageEvent),
    Error(ErrorEvent),
}

match event {
    EventMsg::TurnStarted(e) => handle_start(e),
    EventMsg::TurnComplete(e) => handle_complete(e),
    _ => {}
}
```

**TS:**

```ts
export type EventMsg =
  | { type: 'turn_started'; event: TurnStartedEvent }
  | { type: 'turn_complete'; event: TurnCompleteEvent }
  | { type: 'agent_message'; event: AgentMessageEvent }
  | { type: 'error'; event: ErrorEvent };

switch (event.type) {
  case 'turn_started':  return handleStart(event.event);
  case 'turn_complete': return handleComplete(event.event);
  default: {
    const _exhaustive: never = event;
    return _exhaustive;
  }
}
```

**Rules:**

1. Always use `type` (not `kind`, not `tag`) as the discriminant — matches AgenC runtime serde tagging.
2. Always use `snake_case` for discriminant values — matches AgenC runtime wire format for round-trip compat.
3. Payload field name matches Rust variant content: if variant is `TurnStarted(TurnStartedEvent)`, field is `event`; if tuple has multiple, use `payload`.
4. For exhaustive matching, always add the `_exhaustive: never = event` default. The compiler catches missing variants.

### Rust `Result<T, E>`

Prefer exceptions for most cases:

```rust
fn parse(s: &str) -> Result<Config, ParseError> { ... }

match parse(&s) {
  Ok(c) => use_config(c),
  Err(e) => log::error!("{}", e),
}
```

```ts
function parse(s: string): Config { /* throws ParseError */ }

try {
  const c = parse(s);
  useConfig(c);
} catch (e: unknown) {
  if (e instanceof ParseError) console.error(e.message);
  else throw e;
}
```

Only use a `Result<T, E>` wrapper type if:
- Composing many fallible calls where exceptions would muddle control flow
- Interop with code that already returns a result

---

## Traits and structs

### Rust trait → TS interface

```rust
pub trait ToolOutput {
    fn render(&self) -> String;
    fn token_count(&self) -> usize;
}

pub struct TextOutput { body: String }

impl ToolOutput for TextOutput {
    fn render(&self) -> String { self.body.clone() }
    fn token_count(&self) -> usize { self.body.len() / 4 }
}
```

```ts
export interface ToolOutput {
  render(): string;
  tokenCount(): number;
}

export class TextOutput implements ToolOutput {
  constructor(private readonly body: string) {}
  render(): string { return this.body; }
  tokenCount(): number { return Math.floor(this.body.length / 4); }
}
```

**Naming:** Rust `snake_case` methods become `camelCase`. Rust struct field `foo_bar` → TS `fooBar`. Keep discriminant/serde-tagged field names as `snake_case` for wire compat.

### Lifetimes

Drop them. JS has GC. A Rust signature like `fn foo<'a>(&'a self, ctx: &'a Context<'a>) -> &'a str` becomes `foo(ctx: Context): string`.

### Generics

Rust `fn parse<T: Deserialize>(s: &str) -> Result<T, Error>` → TS `function parse<T>(s: string): T` with the constraint expressed via schema (Zod) or cast.

---

## Ownership and borrowing patterns

### Pass by reference in Rust → just pass in TS

Rust distinguishes `&T` (borrow) from `T` (owned). TS doesn't — objects are always passed by reference. The `readonly` modifier signals intent but doesn't prevent mutation at runtime. Use it liberally for clarity.

### Mutation patterns

- **Interior mutability** (`RefCell`, `Mutex<T>`): use `AsyncLock<T>`.
- **Taking ownership** (`fn consume(self)`): the TS method runs and the object is just discarded; no special syntax needed.
- **Moving into closure**: captured variables in TS closures already behave like moves (reference capture).

### Cloning

Rust `.clone()` → explicit copy in TS:
- Primitives: already by value.
- Arrays: `[...arr]`.
- Objects: `{ ...obj }` for shallow, `structuredClone(obj)` for deep (Node 17+).
- Classes with methods: implement a `.clone()` method on the class itself if semantics matter.

---

## Async / await

| Rust | TypeScript |
|---|---|
| `async fn foo() -> Result<T, E>` | `async function foo(): Promise<T>` (throws on error) |
| `.await` | `await` |
| `tokio::spawn(fut)` | `void fn()` fire-and-forget; for structured: kick off Promise and collect with `Promise.allSettled` |
| `tokio::join!(a, b)` | `await Promise.all([a, b])` |
| `tokio::select!` | `Promise.race([a, b])` for simple cases; for complex branching, use `AbortController` + manual ordering |
| `tokio::time::sleep(d)` | `await new Promise(r => setTimeout(r, ms))` |
| `tokio::time::timeout(d, fut)` | `Promise.race([fut, timeout(ms)])` |
| `CancellationToken` | `AbortController` + `AbortSignal` |

### Cancellation

Rust cancellation tokens map to `AbortController`:

```rust
let token = CancellationToken::new();
let fut = child_token.cancelled();
tokio::select! {
  result = do_work() => { ... },
  _ = fut => { return; },
}
```

```ts
const controller = new AbortController();
await Promise.race([
  doWork(controller.signal),
  new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason));
  }),
]);
```

Every async function that can be cancelled should accept `signal?: AbortSignal` as the last parameter.

---

## Error types

### Rust custom error → TS class extending Error

```rust
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("auth failed: {0}")]
    AuthFailed(String),
    #[error("rate limited, retry after {seconds}s")]
    RateLimited { seconds: u64 },
}
```

```ts
export abstract class ClientError extends Error {
  readonly _tag = 'ClientError';
}

export class AuthFailed extends ClientError {
  readonly reason: string;
  constructor(reason: string) {
    super(`auth failed: ${reason}`);
    this.reason = reason;
    this.name = 'AuthFailed';
  }
}

export class RateLimited extends ClientError {
  readonly seconds: number;
  constructor(seconds: number) {
    super(`rate limited, retry after ${seconds}s`);
    this.seconds = seconds;
    this.name = 'RateLimited';
  }
}
```

**Rules:**
- Always set `this.name` on the instance.
- Use a base abstract class for matching with `instanceof`.
- Type-narrow with `err instanceof AuthFailed`.
- Add a `_tag: string` readonly discriminant if you want non-instanceof matching.

---

## Naming

| Rust | TypeScript |
|---|---|
| Module `turn_context` (file `turn_context.rs`) | File `turn-context.ts`, exports `TurnContext` |
| Type `TurnContext` | `TurnContext` (identical) |
| Function `run_turn` | `runTurn` |
| Field `conversation_id` | `conversationId` (unless wire-serialized, then keep snake_case on serde types — see §enums) |
| Constant `MAX_TURNS` | `MAX_TURNS` (SCREAMING_SNAKE in both) |
| Enum variant `TurnStarted` | union discriminant `'turn_started'` |

### Wire-format types

When porting a type that serializes to JSON matching AgenC runtime's wire format (events, rollout items), **keep `snake_case` field names**:

```ts
export interface TurnStartedEvent {
  turn_id: string;        // wire format
  started_at: number;     // wire format
  model_context_window: number;  // wire format
}
```

For internal types with no wire compat requirement, use camelCase.

---

## Lifetimes and scoping patterns

### `let _guard = lock.lock().await`

RAII drop-on-scope-exit. In TS, use `try/finally` or the `withX` helper pattern on the lock:

```ts
await lock.with(async (state) => {
  // critical section
});
```

### `scope!` / `tokio::spawn` inside a block

If Rust spawns tasks inside a scope and awaits them at end:

```rust
let handles: Vec<_> = items.iter().map(|x| tokio::spawn(process(x))).collect();
for h in handles { h.await?; }
```

```ts
const handles = items.map(x => process(x));
await Promise.all(handles);
```

Use `Promise.allSettled` if you want to collect errors without short-circuiting.

---

## Specific AgenC runtime idioms

### `Arc::clone(&self.foo)`

Just `this.foo`. No special syntax needed.

### `Arc<dyn Trait>`

Interface + instance. No special wrapper.

### `PhantomData<T>`

Usually unneeded in TS. If it encodes a type brand:

```ts
type Branded<T, B extends string> = T & { readonly __brand: B };
type ThreadId = Branded<string, 'ThreadId'>;
```

### `Box<dyn Error + Send + Sync>`

`Error` or `unknown`. No thread-safety markers.

### Macro-generated code (`#[derive(Serialize)]`, `thiserror`, `strum`)

Hand-write the JSON serializer (usually just a plain object). For `strum`-derived enum-to-string, hand-write a `displayName` map.

### `tracing::info_span!("turn", turn_id = ?ctx.sub_id)`

```ts
const span = tracer.startSpan('turn', { attributes: { turn_id: ctx.subId } });
try {
  /* work */
} finally {
  span.end();
}
```

Use OpenTelemetry's Node SDK if we adopt tracing. Otherwise, structured `console.log` with JSON lines.

---

## Checklist for each hand-port file

When opening a Rust file and producing its TS counterpart:

- [ ] Note the file header's purpose in a TS `/**` block at the top.
- [ ] Translate struct definitions → classes or interfaces + types.
- [ ] Translate enum definitions → discriminated unions.
- [ ] Translate `impl` blocks → class methods or free functions.
- [ ] Translate trait definitions → interfaces; implementations → classes with `implements`.
- [ ] Translate async functions; preserve cancellation semantics via `AbortSignal`.
- [ ] Translate `Arc<Mutex<T>>` → `AsyncLock<T>`; `Arc<RwLock<T>>` → `AsyncRwLock<T>`.
- [ ] Translate `tokio::mpsc` → `AsyncQueue`; `tokio::watch` → `BehaviorSubject`.
- [ ] Translate `Result<T, E>` → either `throw E` or `Result<T, E>` wrapper (pick one per API boundary, not per call).
- [ ] Add exhaustiveness `never` checks for every `switch` over discriminated unions.
- [ ] For every public function, add a `/**` JSDoc with one-line purpose (not boilerplate).
- [ ] Run `tsc --noEmit` before moving on; do not commit a file that fails typecheck.
- [ ] Add a test for at least one happy path + one edge case per ported module.

---

## When to deviate

These conventions are defaults. Deviate when:

- **Performance**: If `AsyncLock` overhead shows up in profiling, inline a `Promise` chain directly.
- **Interop**: When a third-party TS library expects `undefined` for "absent," use it instead of `null`.
- **Idiom**: If TypeScript's established idiom is simpler (e.g., `Array.prototype.map` instead of a custom iterator), use the TS idiom — don't mechanically preserve Rust's iterator chain.

Don't deviate for "it's faster to write": write once, consistent, reviewable.

---

## Ported-file layout

Every hand-ported file lives at a deterministic path. The mapping is in
[`runtime-inventory.md`](runtime-inventory.md). When porting a Rust file,
open its entry in that inventory to see the exact destination.

Suffix convention:
- Rust `foo_bar.rs` → TS `foo-bar.ts`
- Rust `FooBar` type exports unchanged
- Internal test file `foo_bar_tests.rs` → TS `foo-bar.test.ts`
