// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import { join } from 'node:path';
import { ConfigMenuView, createConfigMenuSnapshot } from '../config-menu.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

function configStoreFromContext(context: Record<string, unknown>) {
  const direct = context.configStore;
  if (direct && typeof direct === 'object' && typeof direct.current === 'function') {
    return direct;
  }
  const session = context.session;
  const services =
    session && typeof session === 'object' && 'services' in session
      ? session.services
      : undefined;
  const store =
    services && typeof services === 'object' && 'configStore' in services
      ? services.configStore
      : undefined;
  return store && typeof store === 'object' && typeof store.current === 'function'
    ? store
    : null;
}

function stringFromContext(
  context: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = context[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const store = configStoreFromContext(context as Record<string, unknown>);
  if (!store) {
    onDone('ConfigStore not initialised', { display: 'system' });
    return null;
  }
  const home = stringFromContext(context, 'home') ?? process.env.HOME ?? process.cwd();
  const agencHome = stringFromContext(context, 'agencHome') ?? join(home, '.agenc');
  const warnings =
    typeof store.warnings === 'function' ? store.warnings() : [];
  const snapshot = createConfigMenuSnapshot(store.current(), {
    configPath: join(agencHome, 'config.toml'),
    warnings,
  });
  return (
    <ConfigMenuView
      snapshot={snapshot}
      onDone={() => onDone(undefined, { display: 'skip' })}
    />
  );
};
