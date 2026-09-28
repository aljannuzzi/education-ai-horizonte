Entra OAuth isolado
==================

Não monta rotas nem altera o servidor. Sem API keys, fallback ou criação de
apps OAuth. Native Cowork requer OAuthPluginVault; este módulo valida tokens
de acesso e publica metadados de recurso, não implementa um provedor OAuth/DCR.

Configuração: se qualquer MCP_ENTRA_* abaixo estiver definido (mesmo vazio),
todos os cinco valores são obrigatórios; configuração inválida lança
EntraAuthError no startup. PUBLIC_ORIGIN sozinho não habilita Entra.

* MCP_ENTRA_TENANT_ID: GUID do tenant fixo do deployment.
* MCP_ENTRA_CLIENT_ID: GUID da mesma app API + cliente web (aud e azp).
* MCP_ENTRA_ALLOWED_OIDS: GUIDs separados por vírgula; para este deployment,
  configure somente o oid do usuário autorizado.
* MCP_ENTRA_SCOPE: access_as_user (obrigatório, sem default implícito).
* PUBLIC_ORIGIN: origem HTTPS, sem path, credenciais, query ou fragment.

GUIDs de configuração são normalizados para minúsculas; claims devem coincidir
exatamente. Exige RS256, ver=2.0, iss, aud, exp, iat, tid, oid, azp e scp delegado.
nbf é opcional e validado quando presente. Tokens maiores que 16384 bytes,
ID tokens e app-only são recusados. authenticate recebe somente o JWT compacto,
nunca o cabeçalho Bearer inteiro. Nenhum token é registrado ou incluído no erro.

Exemplo para o agente principal adaptar, sem mudanças automáticas no server::

    import { createEntraAuth, EntraAuthError } from '../integrations/entra.js';

    const entra = createEntraAuth(process.env); // startup; não capturar config inválida
    if (entra.configured) {
      app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
        res.json(entra.protectedResourceMetadata);
      });
    }
    app.use('/mcp', async (req, res, next) => {
      try {
        const header = req.get('authorization') ?? '';
        const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
        res.locals.entraIdentity = await entra.authenticate(match?.[1] ?? '');
        next();
      } catch (error) {
        if (!(error instanceof EntraAuthError)) return next(error);
        if (entra.configured) res.set('WWW-Authenticate', entra.challenge);
        res.status(error.status).json({ error: error.code });
      }
    });
    // Montar o handler MCP depois deste middleware, sem fallback para API keys.

O main deve rejeitar Authorization duplicado, manter limites/rate limiting,
não aceitar tokens via cookie/query e autorizar dados pelo oid validado.
Não derivar tenant/origem dos headers da requisição. Configurar o cliente OAuth
separadamente; metadados não prometem registro dinâmico. O main também deve
incluir integrations no build quando integrar; nenhum tsconfig foi alterado.

Validação local (rede simulada, chaves locais, sem bypass por env)::

    npx tsx --test integrations\entra.test.ts
    npx tsc --noEmit --strict --noUncheckedIndexedAccess --types node --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck integrations\entra.ts integrations\entra.test.ts
