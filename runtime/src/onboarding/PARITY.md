# Onboarding Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

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

Intentional reductions:
- The donor account sign-in path is not carried into the default AgenC first-run path. AgenC uses a provider picker, defaults to Grok, and performs a provider-readiness check instead.
- First-run API-key entry is informational in OB-01. Secret capture and persistence belong to the later BYOK onboarding item.
- Terminal setup is represented as an explicit wizard step, but shell-profile mutation is not performed by OB-01.
