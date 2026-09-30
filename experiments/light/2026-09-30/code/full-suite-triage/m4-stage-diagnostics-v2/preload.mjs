import { isMainThread } from 'node:worker_threads';
import { preparePreload } from './diagnostics.mjs';

// Only the proposed test launcher sets this; no production environment changes.
preparePreload(process.env, isMainThread);
