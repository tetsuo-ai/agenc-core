# End-to-end encryption for browser remote sessions

Status: draft for 0.1.8. Decided 2026-09-26 after the remote-session security
review; nothing in this note is built yet.

## Decision

A paired browser and the Core that approved it share a key that only the two
of them hold. Every JSON-RPC request and response that crosses the relay is
encrypted and authenticated with that key. The relay keeps routing frames by
its envelope and keeps enforcing tickets, but it can no longer read a
transcript, an approval prompt or a message, and it can no longer inject a
request into a grant. Today a relay operator, or anyone who compromises the
Worker, can do both within the scope of a control grant; that is the gap this
closes. Ticket authentication, local approval, the Core-side method allowlist
and revocation stay exactly as they are; encryption is added on top, not in
place of them.

## Key agreement at pairing, through the QR

1. `remote.pair.begin` generates an X25519 key pair for the invitation. The
   private key lives with the in-memory pairing record, so it dies with the
   daemon like every grant. The QR and the copied link carry the public key in
   the fragment next to the code: `/pair#code=<code>&hk=<base64url>`. The
   fragment never reaches the relay, the backend or any log; the phone page
   consumes it the way it consumes the code today.
2. The phone page generates its own X25519 key pair when it redeems the code and
   sends its public key with the claim (`devicePublicKey`, one new field on
   `POST /browser-api/claim`, allowlisted by the BFF and stored on the pairing
   row). Core reads it from `host-poll` as `device.publicKey`.
3. Both sides derive the pair key with HKDF-SHA256 over the X25519 shared
   secret, with the pairing id and both public keys as context. Before the
   owner approves, both screens show a fingerprint of that key in place of
   today's device confirmation code. A device that redeemed the code first has
   a different key, so its fingerprint on the computer cannot match the one on
   the owner's phone. The owner still presses Approve on the computer.
4. Each connection derives fresh traffic keys from the pair key and two random
   nonces exchanged in the first frame of the socket, one per direction, so a
   socket key never repeats and a recorded socket cannot be decrypted with a
   later one.

## Frames

The relay envelope does not change: `{t:"data", cid, payload}` with the relay's
authenticated `deviceId`, `role` and `workspaceIds`. The `payload` string
becomes `e1.<counter>.<ciphertext>` instead of JSON-RPC text. The cipher is
AES-256-GCM through WebCrypto on the phone and `node:crypto` in Core, with a
per-direction counter as the nonce and the pairing id, device id, cid and
direction as associated data. A counter that repeats or goes backwards closes
the peer; the existing mutation ledger stays as a second line.

Frame sizes are unchanged apart from the tag and prefix, so the 1 MiB relay
limit and Core's queue limits keep their meaning.

## What the relay still sees

Ticket claims (pairing id, device id, permission, workspace ids, expiry), who
is connected and when, frame sizes and timing, and the `peer` and `status`
control frames. It does not see method names, session ids, transcripts,
approval prompts, file contents or message text. The backend sees the same as
today plus one public key per device; it never sees a private key or the
derived pair key.

## Rotation and revocation

- Pair keys are born and die with a pairing. Revoke, stop, logout and a Core
  restart discard the private key with the grant; the backend row keeps only
  the device's public key, which is useless without the host's private key.
- Traffic keys rotate per socket (step 4). Phone tickets already expire every
  60 seconds, so a connection re-keys at least that often.
- Revocation is unchanged: the backend stops introspecting the ticket as
  active and the relay closes the socket within seconds; Core fences the record
  immediately. Encryption adds nothing a revoked device could use.
- There is no long-lived device identity to rotate across pairings. Re-pairing
  is the rotation.

## Compatibility and rollout

- Core advertises `browserProtocol: "agenc-browser-v3"` in
  `remote.capabilities`; Desktop shows the fingerprint instead of the device
  confirmation code when it sees v3.
- An old phone page (no `hk` in the fragment, no `devicePublicKey` in the
  claim) still pairs; Core marks the grant as not end-to-end encrypted and
  Desktop says so on the approval card. The owner can turn a `require end-to-end
  encryption` setting on to refuse such grants; it becomes the default once
  the phone page has been out for one release.
- Backend: one optional column and one optional claim field. Relay: allowlist
  the field in the BFF. Nothing else moves.
- Not in scope: the legacy phone bridge (`agenc remote on`). It is off by
  default since 0.1.7 and the plan is to move iOS and Android to the v2 grant
  model first, then to this transport.
