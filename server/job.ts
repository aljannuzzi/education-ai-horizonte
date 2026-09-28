import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAutopilot } from './autopilot.js';
import { createStore, type StateStore } from './store.js';

export async function runJob(options: {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  store?: StateStore;
} = {}) {
  const env = options.env ?? process.env;
  const store = options.store ?? createStore(env);
  return runAutopilot(store, 'schedule', options.now ?? new Date(), env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runJob().catch(() => {
    console.error('Falha na preparação agendada. Nenhum sucesso foi confirmado; confira o armazenamento e a configuração.');
    process.exitCode = 1;
  });
}
