import { buildApp } from './app.ts';
import { readConfig } from './config.ts';

try {
  const config = readConfig(process.env);
  const app = buildApp({ ...config, logger: true });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }

  const shutdown = async () => {
    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, 'Failed to close MediBook');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
