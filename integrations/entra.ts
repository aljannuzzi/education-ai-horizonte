import { Buffer } from 'node:buffer';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type EntraAuthCode = 'invalid_configuration' | 'not_configured' | 'invalid_token';

const errors = {
  invalid_configuration: { status: 500, message: 'Invalid Entra authentication configuration.' },
  not_configured: { status: 503, message: 'Entra authentication is not configured.' },
  invalid_token: { status: 401, message: 'Invalid access token.' },
} as const;

export class EntraAuthError extends Error {
  readonly code: EntraAuthCode;
  readonly status: number;

  constructor(code: EntraAuthCode) {
    super(errors[code].message);
    this.name = 'EntraAuthError';
    this.code = code;
    this.status = errors[code].status;
  }
}

export interface EntraIdentity {
  readonly oid: string;
  readonly tid: string;
}

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly ['header'];
}

type Authenticate = (token: string) => Promise<EntraIdentity>;

export type EntraAuth =
  | { readonly configured: false; readonly authenticate: Authenticate }
  | {
      readonly configured: true;
      readonly authenticate: Authenticate;
      readonly protectedResourceMetadata: ProtectedResourceMetadata;
      readonly challenge: string;
    };

export interface EntraAuthOptions {
  /** Dependency injection for trusted callers/tests; never selected by environment flags. */
  readonly keyResolver?: JWTVerifyGetKey;
}

const entraFields = [
  'MCP_ENTRA_TENANT_ID',
  'MCP_ENTRA_CLIENT_ID',
  'MCP_ENTRA_ALLOWED_OIDS',
  'MCP_ENTRA_SCOPE',
] as const;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const compactJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function createEntraAuth(
  env: Readonly<Record<string, string | undefined>>,
  options: EntraAuthOptions = {},
): EntraAuth {
  // PUBLIC_ORIGIN is shared with the web app and does not independently enable Entra.
  if (!entraFields.some((field) => env[field] !== undefined)) {
    return Object.freeze({
      configured: false,
      authenticate: async (_token: string): Promise<EntraIdentity> => {
        throw new EntraAuthError('not_configured');
      },
    });
  }

  const invalidConfig = (): never => { throw new EntraAuthError('invalid_configuration'); };
  const required = (field: string): string => {
    const value = env[field];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : invalidConfig();
  };
  const tenantId = required('MCP_ENTRA_TENANT_ID').toLowerCase();
  const clientId = required('MCP_ENTRA_CLIENT_ID').toLowerCase();
  const scope = required('MCP_ENTRA_SCOPE');
  const oids = required('MCP_ENTRA_ALLOWED_OIDS').split(',').map((oid) => oid.trim().toLowerCase());
  if (!guid.test(tenantId) || !guid.test(clientId) || scope !== 'access_as_user'
    || oids.some((oid) => !guid.test(oid))) {
    invalidConfig();
  }
  const allowedOids = new Set(oids);
  const rawOrigin = required('PUBLIC_ORIGIN');
  let origin: string;
  try {
    const url = new URL(rawOrigin);
    if (!/^https:\/\/[^/?#\\]+\/?$/i.test(rawOrigin)
      || url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
      return invalidConfig();
    }
    origin = url.origin;
  } catch {
    return invalidConfig();
  }

  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const fullScope = `api://${clientId}/${scope}`;
  const keyResolver = options.keyResolver ?? createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
  );
  const protectedResourceMetadata: ProtectedResourceMetadata = Object.freeze({
    resource: `${origin}/mcp`,
    authorization_servers: Object.freeze([issuer]),
    scopes_supported: Object.freeze([fullScope]),
    bearer_methods_supported: Object.freeze(['header'] as const),
  });

  const authenticate: Authenticate = async (token) => {
    if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > 16_384
      || !compactJwt.test(token)) {
      throw new EntraAuthError('invalid_token');
    }
    try {
      const { payload } = await jwtVerify(token, keyResolver, {
        issuer,
        audience: clientId,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'tid', 'oid', 'scp', 'azp', 'ver'],
      });
      // nbf is optional, but jose validates it whenever present.
      if (payload.ver !== '2.0' || payload.tid !== tenantId
        || typeof payload.oid !== 'string' || !allowedOids.has(payload.oid)
        || typeof payload.scp !== 'string' || !payload.scp.split(' ').includes(scope)
        || payload.azp !== clientId || payload.idtyp === 'app'
        || typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000)) {
        throw new EntraAuthError('invalid_token');
      }
      return { oid: payload.oid, tid: tenantId };
    } catch {
      // Neither raw tokens, resolver failures nor untrusted claims escape to logs/callers.
      throw new EntraAuthError('invalid_token');
    }
  };

  return Object.freeze({
    configured: true,
    authenticate,
    protectedResourceMetadata,
    challenge: `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${fullScope}"`,
  });
}
