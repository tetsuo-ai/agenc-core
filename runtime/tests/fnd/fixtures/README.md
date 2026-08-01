# Synthetic contract fixtures

Every payload in this subtree is synthetic, contains no user or production
data, and is unpublished. `manifest.json` is the inventory of payloads; each
entry binds a stable ID and owning task to the exact relative path, byte
length, SHA-256, audited observation, and target contract.

The subtree defaults to Git's `-text` attribute so checkout settings cannot
rewrite payload bytes. This README, `.gitattributes`, and `manifest.json` are
the only control files and are explicitly normalized to LF. The integrity
test rejects an unmanifested payload, a missing payload, a symlink, a path
escape, duplicate IDs or paths, and any byte-length or digest mismatch.

Do not edit a payload in place to serve a new contract. Add a versioned
fixture, update the frozen ID inventory, and regenerate the manifest metadata
from raw bytes. Production readers must not import this test corpus.
