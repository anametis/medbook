const emptyOperations = [
  'listDoctors', 'getAvailability', 'listPatients', 'listPatientAppointments', 'listDoctorAppointments',
] as const;

const errorOperations = [
  ...emptyOperations, 'getDoctor', 'getAppointment', 'bookAppointment', 'cancelAppointment', 'getDoctorDashboard',
] as const;

type EmptyOperation = (typeof emptyOperations)[number];
type ErrorOperation = (typeof errorOperations)[number];
export type Simulation = { mode: 'empty'; operation: EmptyOperation } | { mode: 'error'; operation: ErrorOperation };

export const defaultCorsOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function integer(raw: string | undefined, name: string, fallback: number, min: number, max: number) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(name + ' must be an integer from ' + min + ' to ' + max + '.');
  }
  return value;
}

function isHttpOrigin(origin: string) {
  const url = URL.parse(origin);
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
}

function isChoice<T extends string>(choices: readonly T[], value: string): value is T {
  return choices.some((choice) => choice === value);
}

function readSimulation(mode = 'normal', operation = ''): Simulation | undefined {
  if (mode === 'normal' && operation === '') return;
  if (mode === 'empty' && isChoice(emptyOperations, operation)) return { mode, operation };
  if (mode === 'error' && isChoice(errorOperations, operation)) return { mode, operation };
  throw new Error('Set SIMULATION_MODE and SIMULATION_OPERATION to a supported combination from the README.');
}

export function databasePath(env: NodeJS.ProcessEnv) {
  return env.DB_PATH || './data/medibook.sqlite';
}

export function readConfig(env: NodeJS.ProcessEnv) {
  const corsOrigins = env.CORS_ORIGINS === undefined
    ? defaultCorsOrigins
    : env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!corsOrigins.every(isHttpOrigin)) throw new Error('CORS_ORIGINS must contain exact HTTP or HTTPS origins.');
  return {
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 'PORT', 3001, 1, 65535),
    dbPath: databasePath(env),
    latencyMs: integer(env.LATENCY_MS, 'LATENCY_MS', 300, 0, 30000),
    corsOrigins,
    simulation: readSimulation(env.SIMULATION_MODE, env.SIMULATION_OPERATION),
  };
}
