# Eval pilot executor — phase 2b egress control

Status: implemented and **proven end to end against a real provider**. The
first real-model run (grok-4.5 on the adm-zip pilot task) produced a
hidden-verifier-passing patch inside a fully contained lane
(`oracleContainment: contained`, all probes true, `patchKeyScan: clean`).

Live-run note — headless proxy: the runtime installs its undici proxy
dispatcher (`configureGlobalAgents`) only on the interactive TUI path, so the
daemon behind `agenc -p` ignored `HTTPS_PROXY` and attempted a direct model
call, which the egress lane's blackholed resolver correctly refused. The lane
now injects `NODE_OPTIONS=--require .../proxy/eval-proxy-preload.cjs` into the
agent (inherited by the daemon), which installs the dispatcher from
`HTTPS_PROXY`. The proper fix is to have the runtime configure the proxy in
headless mode too (a separate follow-up); the preload can then be dropped.

Implementation notes / deviations from the original design, all made during
the adversarial review:

- **Sidecar uid.** The sidecar runs as the executor's own uid:gid, not
  `65534:65534`. A dedicated nobody uid cannot traverse an operator's private
  scratch overlay dir; the executor uid can. All other hardening
  (`--cap-drop ALL`, `no-new-privileges`, `--read-only`, pid/memory limits,
  no docker socket) is retained. For maximum isolation an operator can stage a
  world-readable overlay and revert to a nobody uid.
- **Containment probes** run in the agent container via the overlay's node
  (tool-independent) and fail closed. `noRouteOffNet` was strengthened beyond
  a single public-IP reachability test to also require no IPv4 default route
  (`/proc/net/route`) and that the bridge gateway is unreachable on common
  host-service ports — closing the one "reach host-bound services" path the
  probe otherwise could not see. `ipv6Absent` uses a public-v6 reachability
  test (a `/proc/net/ipv6_route` parse proved fragile across kernels).
- **Key redaction.** Beyond scanning the patch, the provider key is scanned in
  the agent's stdout result and stderr and redacted from every persisted /
  digested text artifact; a hit quarantines the run. A too-short key and a
  model / base URL containing shell metacharacters are rejected up front.

Phase 2a ships the offline agent-run lane (`--network none`, bundled
in-container mock provider). Phase 2b lets the agent reach a **real** model
provider API without letting a `--yolo` agent fetch the upstream fix
(the tasks are cut from merged public GitHub PRs) or exfiltrate the provider
key (untrusted issue text can prompt-inject the agent). See
`eval-pilot-executor.md` "Phase 2b" for why this could not be part of 2a.

## Chosen approach: internal-network forward-proxy sidecar

The security boundary is **topological, not a ruleset**. The agent joins a
docker `--internal` network with no route off the box; a root agent that
unsets `HTTPS_PROXY` or opens a raw socket still cannot leave — there is
nothing to flush, no `NET_ADMIN` to hold, no host root required. Proxy env
only makes the *allowed* path work.

Rejected alternatives: an iptables/nftables egress firewall (a root `--yolo`
agent with `NET_ADMIN`, or a rule-flush, subverts it; DNS/IP allowlisting is
brittle to CDN churn) and DNS-restriction (the agent can hardcode IPs to
bypass name-based blocking). Both scored below the sidecar on security and
robustness; their best mitigations are grafted in below.

The verification and auxiliary containers stay `--network none` **always** —
the softer egress boundary is never on the oracle-scoring path.

## Network topology (per run)

Two per-run networks, created before the agent and torn down in `finally`:

1. `agenc-eval-egress-<run>` — `docker network create --internal --subnet
   10.88.<r>.0/29` (no IPv6). Internal ⇒ no NAT/route to internet or host.
   The agent joins **only** this net.
2. `agenc-eval-upstream-<run>` — a normal NAT bridge that **only the sidecar**
   joins. In production it reaches the real provider; in the hermetic test it
   is a second `--internal` net carrying the mock provider + a github sink, so
   the agent's "no NIC there ⇒ no route" property is identical in test and
   prod.

The sidecar is dual-homed at a static IP on the egress net (e.g.
`10.88.<r>.2`); the agent's `HTTPS_PROXY` points at that IP:port, so
reachability never depends on DNS — which lets the agent resolver be
blackholed (`--dns 127.0.0.1`).

## The sidecar proxy

A small deny-by-default HTTP `CONNECT` proxy shipped inside the read-only
overlay (`overlay/proxy/allowlist-proxy.mjs`), run by the overlay's pinned
`node`. It is added to `assertOverlayLayout()` and folded into
`computeOverlayDigest()`, so the report attests which proxy enforced egress.

Config via env (delivered by `-e`): `AGENC_PROXY_ALLOW_HOST` (exact host),
`AGENC_PROXY_ALLOW_PORT` (443), `AGENC_PROXY_PIN_IPS` (host-resolved A
records). Enforcement, in strict order:

1. Accept only HTTP `CONNECT`; plaintext absolute-form → `403` (no open-relay).
2. Parse `CONNECT host:port`. **Reject before any DNS resolution** if host is
   not the exact allow-host or port is wrong. Deny-before-resolve closes the
   proxy's-own-resolver leak channel (never looks up `<secret>.attacker.com`).
3. Reject IP-literal authorities — allowlist is hostname-only.
4. Buffer the TLS ClientHello, extract SNI, require `SNI === ALLOW_HOST`, then
   replay bytes upstream (defeats domain-fronting).
5. `net.connect` to `PIN_IPS` only (not a fresh resolution); validate the
   upstream leaf cert chain for `ALLOW_HOST` (defeats mid-run DNS rebind).
   Then `200` and splice — TLS stays end-to-end to the real provider.

Sidecar flags: `--read-only --cap-drop ALL --security-opt no-new-privileges
--user 65534:65534 --pids-limit 128 --memory 128m`, mounts no task material.

GitHub is blocked by **default-deny**, not a blocklist: one exact allowed host
⇒ github.com / api.github.com / raw.githubusercontent.com / codeload all fail
at step 2 (never resolved), by IP at step 3, at the kernel (no route) for a
raw socket, and at the resolver for a name lookup. Complements the `.git`
hygiene already in `buildBaselineGitScript()`.

## docker CLI orchestration

New `createEgressTaskContainer()` on `DockerContainerRunner` plus a
network/sidecar lifecycle wrapper in `runAgentOnTask`. All via
`spawnBounded("docker", […])`:

```
# 0. Host-resolve the provider once (injectable resolver) -> PIN_IPS.
docker network create --internal --subnet 10.88.<r>.0/29 agenc-eval-egress-<run>
docker network create agenc-eval-upstream-<run>                 # NAT (prod)
docker create --name agenc-eval-proxy-<run> \
  --network agenc-eval-egress-<run> --ip 10.88.<r>.2 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 65534:65534 --pids-limit 128 --memory 128m \
  -e AGENC_PROXY_ALLOW_HOST -e AGENC_PROXY_ALLOW_PORT -e AGENC_PROXY_PIN_IPS \
  -v <overlay>:/agenc-overlay:ro \
  --entrypoint /agenc-overlay/node/bin/node \
  <pinned-image@sha256> /agenc-overlay/proxy/allowlist-proxy.mjs
docker network connect agenc-eval-upstream-<run> agenc-eval-proxy-<run>
docker start agenc-eval-proxy-<run>          # + loopback CONNECT self-probe
docker create --network agenc-eval-egress-<run> --dns 127.0.0.1 \
  <overlay ro> --entrypoint sleep <task-image@sha256> infinity
docker start <agent>
# run agent (secrets below); collect patch; teardown (idempotent, in finally)
docker rm -f <agent> agenc-eval-proxy-<run>
docker network rm agenc-eval-egress-<run> agenc-eval-upstream-<run>
```

`buildAgentScript` drops the mock block and instead exports
`HTTPS_PROXY=http://10.88.<r>.2:<port>`, `AGENC_PROXY_RESOLVES_HOSTS=1` (makes
undici put the hostname in the CONNECT authority, so `--dns 127.0.0.1` is a
hard blackhole rather than breakage), `NO_PROXY=`, and the real provider
`OPENAI_COMPATIBLE_BASE_URL`/model. The key is **not** assigned here.

## Secret delivery — `docker exec -e`, never argv

Extend `ContainerExecRequest` with `envPassthrough?: readonly string[]`
(variable **names** only). In `DockerContainerRunner.exec`, append `-e NAME`
(no `=`) per name; `spawn` inherits the executor's `process.env`, so the docker
CLI reads the value from its own environment — the value is on no command line
(not in `buildAgentScript`, not in `docker create --env`, not in any argv).

Hardening (deferred variant): deliver the key to the **sidecar** as a
TLS-terminating auth-injector and give the agent a dummy key, so prompt
injection has nothing to steal (codebase already supports client CA trust via
`getCACertificates()`/`NODE_EXTRA_CA_CERTS`). Ship the opaque-tunnel form
first (key in agent via `-e`, exfil bounded to "can only reach its own
issuer"); upgrade when key-exfil is the primary concern. Also: use a
short-TTL, budget-capped, provider-scoped key, and **scan the collected patch
bytes for the key substring** before `verifyCandidatePatch`; if present, force
`infrastructure_error` and quarantine.

## Contamination marker (carried until proven)

The report body (folded into `REPORT_DIGEST_DOMAIN`) gains:

```
egress: {
  mode: "real-provider",
  allowHost, keyExposure: "agent-env" | "sidecar-only",
  sidecarOverlayDigest,
  oracleContainment: "unverified",   // starts here
  denyProbes: { githubBlocked, dnsBlackholed, noRouteOffNet,
                ipv6Absent, ipLiteralRejected, sniPinned },
  patchKeyScan: "clean" | "key-substring-found",
}
```

`oracleContainment` flips to `"contained"` **only** when every `denyProbes`
field is true AND `patchKeyScan === "clean"`. Otherwise it stays
`"unverified"`, `runAgentOnTask` forces a new `oracle_containment_unverified`
outcome, **the agent is not started** (probes run pre-agent), and the run is
excluded from any scored aggregate. Because the marker is inside the digested
report, a consumer can cryptographically distinguish a contained run from an
unverified one. There is **no** degraded "bare bridge" fallback — any setup
failure aborts.

## Offline test plan

- **Tier 1 — pure unit, no docker (revert-sensitive).** Drive
  `allowlist-proxy.mjs` over loopback with raw bytes: allowed host tunnels,
  github → 403, deny-before-resolve (stub dns, assert never called for a denied
  host), IP-literal → 403, plaintext → 403, wrong port → 403, SNI mismatch
  dropped. Revert-sensitivity: widen the allowlist to accept github and assert
  the denied-host test flips green.
- **Tier 2 — arg-shape unit, no docker.** Golden-assert the docker argv: agent
  gets `--network agenc-eval-egress-*` + `--dns 127.0.0.1` and not
  `--network none`; sidecar carries `--internal`/`--read-only`/`--cap-drop
  ALL`/`no-new-privileges`/static `--ip`; the agent `exec` argv has
  `-e OPENAI_COMPATIBLE_API_KEY` with no `=value`; the raw key appears in no
  argv and not in `buildAgentScript`. Fail-closed: a stubbed network/sidecar
  failure aborts with `oracle_containment_unverified`, never a bare bridge.
- **Tier 3 — hermetic docker integration, real dockerd, no internet**
  (docker-gated like the existing live e2e). Fake the internet with a second
  `--internal` net (agent has no NIC there) carrying the mock provider
  (alias = allow-host) and a github sink (alias github.com). Assert offline:
  allowed path 200; github → 403; raw route to the github-sink IP times out
  (the load-bearing L3 proof); `getent hosts github.com` fails; no key in
  `docker inspect`/`env`; combined injection all fails; revert-sensitive
  widen-allowlist probe; and the real overlay `agenc.js` reaches the mock
  **through the sidecar** via CONNECT (proves undici honors the proxy env).
- **Cannot be proven offline** (opt-in `AGENC_EVAL_LIVE=1` smoke): real
  provider reachability/TLS, real domain-fronting, real rebind timing.
  Offline-green is necessary, not sufficient; a live smoke is mandatory before
  trusting phase 2b on real providers.

## Residual risks (bounded by hard-fail preflight)

1. Host services on the internal bridge gateway — preflight asserts the agent's
   `ip route` shows only the `/29`; hard-fail otherwise.
2. IPv6 leak if dockerd has IPv6 — preflight asserts `ip -6 route` empty
   (`denyProbes.ipv6Absent`); hard-fail otherwise.
3. Sidecar confused-deputy (parser bug) — minimal deny-by-default parser +
   exhaustive Tier-1 revert-sensitive suite; pinned + overlay-digest-attested.
4. Covert channel to the provider itself — unpreventable, out of scope; reaches
   only the legitimate issuer. The auth-injecting variant hides the key.
5. Container escape / kernel confinement — pre-existing phase-2a gap; this
   controls egress, not seccomp/userns. Mitigated by `--cap-drop ALL`,
   `no-new-privileges`, no docker socket, limits; verification stays
   `--network none`.
6. DNS-rebind on the allowed host — bounded by pinned IPs + upstream cert
   validation; churn fails **closed** (reliability cost, not a leak).
7. Fail-open is designed out — any setup failure quarantines the run.

## Implementation order

1. `allowlist-proxy.mjs` + Tier-1 revert-sensitive unit tests (security core,
   fully offline).
2. `envPassthrough` secret delivery + the containment-marker report fields +
   `oracle_containment_unverified` outcome + Tier-2 arg-shape tests.
3. `createEgressTaskContainer` orchestration + the real-provider path in
   `runAgentOnTask` (behind an explicit real-provider config, default off).
4. Tier-3 hermetic docker integration test.
5. Opt-in live smoke; only then is phase 2b trustworthy on real providers.
