import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreatePreviewServer } from 'astro';

const preview: CreatePreviewServer = async ({
  serverEntrypoint,
  host,
  port,
}) => {
  const serverDir = dirname(fileURLToPath(serverEntrypoint));
  const targetHost = host ?? 'localhost';
  const targetPort = port ?? 4321;

  const proc = Bun.spawn(['bun', 'run', join(serverDir, 'index.mjs')], {
    env: { ...process.env, HOST: targetHost, PORT: String(targetPort) },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return {
    host: targetHost,
    port: targetPort,
    stop() {
      proc.kill();
      return Promise.resolve();
    },
    closed() {
      return proc.exited.then(() => {});
    },
  };
};

export default preview;
