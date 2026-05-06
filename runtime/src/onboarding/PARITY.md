# Onboarding Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow donor citation in local parity artifact -->

Primary source anchors:
- `src/components/Onboarding.tsx`
- `src/projectOnboardingState.ts`
- `src/projectOnboardingSteps.ts`
- `src/components/LogoV2/WelcomeV2.tsx`

This directory owns AgenC's first-run onboarding surface:
- `Onboarding.tsx` provides the first-run wizard controller and rendered TUI view.
- `WelcomeV2.tsx` renders the AgenC welcome header used by onboarding.
- `elements.tsx` keeps onboarding render primitives inside the strict onboarding compile surface.
- `projectOnboardingState.ts` persists first-run and project-onboarding state in the AgenC home directory.
- `projectOnboardingSteps.ts` detects project-onboarding completion from workspace state.
- `ApproveApiKey.tsx`, `useApiKeyVerification.ts`, `inputPaste.ts`, and `pasteStore.ts` provide the OB-09 BYOK key-entry counterparts.
- `runtime/src/tui/components/App.tsx` owns the runtime first-run render and composer-submit integration for this controller.

OC-09 project-onboarding contract:
- `projectOnboardingState.ts` owns per-project seen counts, completion persistence, demo-mode suppression, and malformed-state recovery.
- `projectOnboardingSteps.ts` owns the two-step project sequence: empty workspace creation, then AGENC.md project instructions for non-empty workspaces.

Intentional reductions:
- The donor account sign-in path is not carried into the default AgenC first-run path. AgenC uses a provider picker, defaults to Grok, and performs a provider-readiness check instead.
- First-run API-key entry is informational in OB-01. OB-09 adds explicit BYOK paste, provider verification, masked-tail approval, and private LocalAuthBackend persistence.
- Terminal setup is represented as an explicit wizard step, but shell-profile mutation is not performed by OB-01.
- Project onboarding state is stored in AgenC onboarding state rather than donor project config.
- Project onboarding detects AGENC.md only; donor-specific instruction filenames are intentionally not accepted.
- OB-09 stores approved provider keys as provider-neutral BYOK records rather than donor approved/rejected tail lists in UI config.
- OB-09 uses AgenC runtime provider metadata for verification and does not execute donor-specific API-key helper commands.
- OB-09 paste storage is silent and private; it does not emit secret-bearing telemetry or logs, does not render raw large-paste previews for API keys, and writes paste-cache files only after explicit approval.
