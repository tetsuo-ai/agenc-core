# Contributing to AgenC Core

Thanks for helping. If you are new here, start with an issue labeled
[good first issue](https://github.com/tetsuo-ai/agenc-core/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22).
Each one is small and says how to check your work.

## Set up

You need Node 26.5 or a later 26.x and npm 11.

```bash
git clone https://github.com/tetsuo-ai/agenc-core.git
cd agenc-core
npm ci
git config core.hooksPath .githooks
npm run build
node runtime/bin/agenc --help
```

The pre-commit hook in `.githooks/` checks the staged diff for whitespace errors.

## Make a change

1. Branch off `main`. Never commit to `main` directly.
2. For a bug fix, add a regression test that fails without your fix.
3. Write new tests with Vitest under `runtime/tests/`. To run one file:

   ```bash
   npm --workspace=@tetsuo-ai/runtime run test:host-functional -- tests/utils/example.test.ts
   ```

4. Before you open a pull request, run `npm run typecheck` and `npm run test:fast`.
   If your change touches a specific package or subsystem, also run the check that
   covers it.
5. Use conventional commit messages, for example `fix(runtime): keep the cursor on resize`.
   Pull requests are squash-merged. Do not bypass hooks with `--no-verify`.

## Docs-only changes

Pull requests that only change files under `docs/` or `README.md` do not start CI.
Check your links and the rendered preview on GitHub before you ask for review.

## Questions and security

Ask questions in [Discussions](https://github.com/tetsuo-ai/agenc-core/discussions).
Please do not report security problems in public issues. See
[security.txt](https://agenc.ag/.well-known/security.txt) for how to report them privately.
