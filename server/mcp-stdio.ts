import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSemanticMcpServer } from './mcp.js';

// Local process access is the STDIO trust boundary; cloud bearer auth lives in mountMcp.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createSemanticMcpServer();
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= server.close().catch(() => { process.exitCode = 1; });
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  process.stdin.once('end', () => { void close(); });
  try {
    await server.connect(transport);
  } catch {
    console.error('Não foi possível iniciar o MCP local.');
    process.exitCode = 1;
    await close();
  }
}
