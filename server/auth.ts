import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { SessionInfo } from '../shared/contracts.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const COOKIE = 'horizonte_session';
const AUTH_SECONDS = 8 * 60 * 60;
const ANONYMOUS_SECONDS = 30 * 60;
const tokenSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  csrf: z.string().regex(/^[a-f0-9]{64}$/),
  authenticated: z.boolean(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
type Token = z.infer<typeof tokenSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));

export function createAuth(env: NodeJS.ProcessEnv) {
  const accessKey = env.DEMO_ACCESS_KEY;
  if (!accessKey?.trim()) {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED', 'Configure DEMO_ACCESS_KEY antes de iniciar.');
  }
  const production = env.NODE_ENV === 'production';
  let publicOrigin: string | undefined;
  if (env.PUBLIC_ORIGIN !== undefined) {
    try {
      const url = new URL(env.PUBLIC_ORIGIN);
      if (url.origin !== env.PUBLIC_ORIGIN || !['http:', 'https:'].includes(url.protocol)
        || (production && url.protocol !== 'https:')) throw new Error();
      publicOrigin = url.origin;
    } catch {
      throw new HttpError(503, 'AUTH_CONFIG', 'PUBLIC_ORIGIN deve ser uma origem válida, sem caminho.');
    }
  } else if (production) {
    throw new HttpError(503, 'AUTH_CONFIG', 'PUBLIC_ORIGIN HTTPS é obrigatório em produção.');
  }
  // Process-local signing and active sessions invalidate cookies on restart and logout.
  const signingKey = createHmac('sha256', accessKey).update(randomBytes(32)).digest();
  const active = new Map<string, number>();
  const signature = (value: string) => createHmac('sha256', signingKey).update(value).digest('base64url');
  const now = () => Math.floor(Date.now() / 1000);
  const prune = () => {
    const time = now();
    for (const [id, exp] of active) if (exp <= time) active.delete(id);
  };
  const read = (req: Request): Token | undefined => {
    const cookies = (req.headers.cookie ?? '').split(';')
      .map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return;
    const cookie = cookies[0]!.slice(COOKIE.length + 1);
    if (cookie.length > 1024) return;
    const parts = cookie.split('.');
    if (parts.length !== 2) return;
    const [payload, mac] = parts;
    if (!payload || !mac || !/^[A-Za-z0-9_-]+$/.test(payload)
      || !/^[A-Za-z0-9_-]{43}$/.test(mac) || !equal(mac, signature(payload))) return;
    try {
      const token = tokenSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      const time = now();
      const maxAge = token.authenticated ? AUTH_SECONDS : ANONYMOUS_SECONDS;
      if (token.iat > time || token.exp <= time || token.exp <= token.iat
        || token.exp - token.iat > maxAge) return;
      if (token.authenticated && active.get(token.id) !== token.exp) return;
      return token;
    } catch {
      return;
    }
  };
  const issue = (res: Response, authenticated: boolean): SessionInfo => {
    prune();
    if (authenticated && active.size >= 10_000) {
      throw new HttpError(503, 'SESSION_CAPACITY', 'Limite de sessões atingido. Tente novamente mais tarde.');
    }
    const iat = now();
    const seconds = authenticated ? AUTH_SECONDS : ANONYMOUS_SECONDS;
    const token: Token = {
      id: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex'),
      authenticated, iat, exp: iat + seconds,
    };
    const payload = Buffer.from(JSON.stringify(token)).toString('base64url');
    if (authenticated) active.set(token.id, token.exp);
    res.cookie(COOKIE, `${payload}.${signature(payload)}`, {
      httpOnly: true, sameSite: 'strict', secure: production, path: '/', maxAge: seconds * 1000,
    });
    return { authenticated, csrfToken: token.csrf };
  };
  const mutation: RequestHandler = (req, _res, next) => {
    let expected = publicOrigin;
    if (!expected) {
      try {
        const local = new URL(`${req.protocol}://${req.get('host') ?? ''}`);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) throw new Error();
        expected = local.origin;
      } catch {
        return next(new HttpError(403, 'ORIGIN_FORBIDDEN', 'Origem da requisição não autorizada.'));
      }
    }
    if (req.get('origin') !== expected) {
      return next(new HttpError(403, 'ORIGIN_FORBIDDEN', 'Origem da requisição não autorizada.'));
    }
    const token = read(req);
    const csrf = req.get('x-csrf-token');
    if (!token || !csrf || csrf.length !== 64 || !equal(csrf, token.csrf)) {
      return next(new HttpError(403, 'CSRF_INVALID', 'Atualize a sessão antes de enviar alterações.'));
    }
    next();
  };
  const requireSession: RequestHandler = (req, _res, next) => {
    if (!read(req)?.authenticated) {
      return next(new HttpError(401, 'AUTH_REQUIRED', 'Entre para acessar os dados da demonstração.'));
    }
    next();
  };
  return {
    mutation,
    requireSession,
    session(req: Request, res: Response): SessionInfo {
      const token = read(req);
      return token ? { authenticated: token.authenticated, csrfToken: token.csrf } : issue(res, false);
    },
    login(req: Request, res: Response, candidate: string): SessionInfo {
      if (!equal(candidate, accessKey)) {
        throw new HttpError(401, 'LOGIN_FAILED', 'Chave de acesso inválida.');
      }
      const previous = read(req);
      const session = issue(res, true);
      if (previous?.authenticated) active.delete(previous.id);
      return session;
    },
    logout(req: Request, res: Response): void {
      const token = read(req);
      if (token) active.delete(token.id);
      res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: production, path: '/' });
    },
  };
}
