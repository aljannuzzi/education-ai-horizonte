import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';

export { createApp } from './app.js';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const rawPort = process.env.PORT ?? '8080';
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Porta inválida.');
    }
    const server = createApp().listen(port, '0.0.0.0', () => {
      console.info(`Horizonte disponível na porta ${port}.`);
    });
    server.on('error', () => {
      console.error('Não foi possível iniciar o servidor Horizonte.');
      process.exitCode = 1;
    });
  } catch {
    console.error('Não foi possível iniciar o Horizonte. Verifique a configuração do servidor.');
    process.exitCode = 1;
  }
}
