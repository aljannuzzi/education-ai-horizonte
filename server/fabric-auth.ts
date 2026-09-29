import { ClientSecretCredential } from '@azure/identity';
import { FABRIC_SCOPE, FabricError } from './fabric.js';

/** Compatible with explicitly supplied ClientSecretCredential or OnBehalfOfCredential. */
export interface TokenCredential {
  getToken(
    scope: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ token: string } | null>;
}

export type FabricTokenProvider = (scope: string, signal: AbortSignal) => Promise<string>;

export interface FabricAuthDependencies {
  credential?: TokenCredential;
  getFabricToken?: FabricTokenProvider;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

export function createFabricTokenProvider(
  env: NodeJS.ProcessEnv,
  deps: FabricAuthDependencies = {},
): FabricTokenProvider {
  let acquire: FabricTokenProvider;
  try {
    const mode = env.FABRIC_AUTH_MODE;
    const tenant = env.FABRIC_TENANT_ID;
    const client = env.FABRIC_CLIENT_ID;
    const secret = env.FABRIC_CLIENT_SECRET;
    const hasConfig = [tenant, client, secret].some(value => value !== undefined);
    const credential = deps.credential;
    const callback = deps.getFabricToken;
    const hasCredential = credential !== undefined;
    const hasCallback = callback !== undefined;

    if (env.FABRIC_TOKEN !== undefined || env.FABRIC_ACCESS_TOKEN !== undefined
      || (hasCredential && hasCallback)) {
      throw new FabricError('INVALID_CONFIG');
    }

    if (mode === 'client-secret') {
      if (hasCredential || hasCallback
        || typeof tenant !== 'string' || tenant.length !== 36 || !UUID.test(tenant)
        || typeof client !== 'string' || client.length !== 36 || !UUID.test(client)
        || typeof secret !== 'string' || !secret.trim()) {
        throw new FabricError('INVALID_CONFIG');
      }
      const explicitCredential = new ClientSecretCredential(tenant, client, secret);
      acquire = async (scope, signal) =>
        (await explicitCredential.getToken(scope, { abortSignal: signal }))?.token as string;
    } else {
      if ((mode !== undefined && mode !== 'token-provider') || hasConfig
        || (!hasCredential && !hasCallback)
        || (hasCallback && typeof callback !== 'function')
        || (hasCredential && (!credential || typeof credential.getToken !== 'function'))) {
        throw new FabricError('INVALID_CONFIG');
      }
      acquire = callback ?? (async (scope, signal) =>
        (await credential!.getToken(scope, { abortSignal: signal }))?.token as string);
    }
  } catch {
    // Never retain a dependency's error, message, status, or cause.
    throw new FabricError('INVALID_CONFIG');
  }

  return async (scope, signal) => {
    if (scope !== FABRIC_SCOPE) throw new FabricError('INVALID_CONFIG');
    if (signal.aborted) throw new FabricError('CANCELLED');

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const cancel = () => finish('CANCELLED');
      const finish = (code?: 'AUTH_FAILED' | 'CANCELLED', token?: string) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        if (code) reject(new FabricError(code));
        else resolve(token!);
      };
      signal.addEventListener('abort', cancel, { once: true });
      // Check again after registration and before invoking the dependency.
      if (signal.aborted) {
        cancel();
        return;
      }
      void Promise.resolve().then(async () => {
        if (settled) return;
        try {
          const token = await acquire(FABRIC_SCOPE, signal);
          if (signal.aborted) finish('CANCELLED');
          else if (typeof token !== 'string' || token.length > 32_000
            || token.trim() !== token || !BEARER_TOKEN.test(token)) finish('AUTH_FAILED');
          else finish(undefined, token);
        } catch {
          finish(signal.aborted ? 'CANCELLED' : 'AUTH_FAILED');
        }
      });
    });
  };
}
