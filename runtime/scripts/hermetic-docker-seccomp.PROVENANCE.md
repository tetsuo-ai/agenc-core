# Hermetic Docker seccomp profile provenance

- Upstream: `moby/profiles`
- Source: `seccomp/default.json`
- Tag: `seccomp/v0.2.3`
- Tag commit: `f1a0fd6b5a369fca061b041539129661ed337ef5`
- Upstream SHA-256: `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`
- Vendored SHA-256: `de1f5327ca42b80be02daba8d39c0d087a530dc3c16f7028170fe068c9d66e61`
- Local change: one terminal newline was added; JSON content is otherwise unchanged.
- License: Apache-2.0; see `hermetic-docker-seccomp.LICENSE`.

The test prelauncher verifies the vendored hash, copies the bytes to a private
supervisor-owned path, and passes that snapshot to the local Docker daemon.
