# Narrow denied-health-lookup owner successor

Only `owner-entry.ts` succeeds the frozen original. It imports the existing
`linux-preflight-v2/fetch-classifier.mjs` and rejects the exact bodyless
`GET https://api.openai.com/v1/models` before `joined.assertDispatched()`.
That denial never invokes the observer or fake/native transport and cannot mark
the selected-turn join invalid. Every other request still follows the original
dispatch check and unchanged observer. No POST/Responses admission, financial,
receipt, source-selection, foreground or cleanup algorithm is replaced.

The only other source delta is rebasing imports to the frozen sibling module
locations. Root must redirect the original owner's `owner-entry.js` import from
`owner-caller.ts` to this explicit successor, include the classifier in the pinned
build manifest and graph, and preserve redirects for the original selection
modules. No existing builder, source or selection has been edited here.

`owner-entry.test.mjs` exercises the actual successor entry with synthetic
foreground/validator/observer modules and a fake response, plus exact-classifier
near-miss controls. Synthetic Linux/IPC properties are test-local, not real Linux
readiness. It verifies denied health calls before selection, unpoisoned later
POST dispatch with unchanged request/init identity, unknown-route refusal and
closed-owner denial. It does not replace real observer/accounting or full CLI
integration tests. No actual Core, provider, journal or network is invoked.
