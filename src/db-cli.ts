import { databasePath } from './config.ts';
import { resetDatabase } from './db.ts';

try {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Database maintenance commands are available for development and assessments.');
  }

  const action = process.argv[2];
  if (action !== 'reset' && action !== 'seed') throw new Error('Use npm run db:reset or npm run db:seed.');

  const path = databasePath(process.env);
  const date = resetDatabase(path, action);
  const verb = action === 'reset' ? 'Restored' : 'Generated';
  console.log(verb + ' MediBook fixtures for ' + date + ' (Asia/Tehran) in ' + path);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
