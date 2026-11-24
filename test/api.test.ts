import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync as Database } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { buildApp, type AppOptions } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { resetDatabase } from '../src/db.ts';

const prefix = '/api/v1';
const seedNow = Date.parse('2026-11-24T21:00:00.000Z');
const tomorrow = '2026-11-26';
const demo = 'patient-01';
const doctor = 'doctor-01';

function setup(t: TestContext, options: Partial<AppOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'medibook-test-'));
  const dbPath = join(dir, 'test.sqlite');
  const settings = { dbPath, now: () => seedNow, latencyMs: 0, ...options };
  const app = buildApp(settings);
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, dbPath, settings };
}

type App = ReturnType<typeof buildApp>;
type Slot = { id: string; startAt: string; endAt: string; status: string };
type Appointment = {
  id: string;
  doctorId: string;
  patientId: string;
  timeSlotId: string;
  status: string;
  cancelledAt: string | null;
  reason: string | null;
  doctor: { id: string };
  patient: { id: string };
  timeSlot: Slot;
};

async function slots(app: App, doctorId = doctor, date = tomorrow) {
  const response = await app.inject(prefix + '/doctors/' + doctorId + '/availability?date=' + date);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ date: string; timeZone: string; slots: Slot[] }>();
  assert.equal(body.date, date);
  assert.equal(body.timeZone, 'Asia/Tehran');
  return body.slots;
}

function book(app: App, timeSlotId: string, doctorId = doctor, patientId = demo) {
  return app.inject({
    method: 'POST',
    url: prefix + '/appointments',
    payload: { doctorId, patientId, timeSlotId, reason: 'Fictional assessment visit' },
  });
}

test('lists fictional identities, searches both fields, and serves avatar URLs', async (t) => {
  const { app } = setup(t);
  const all = await app.inject(prefix + '/doctors');
  assert.equal(all.statusCode, 200);
  const doctors = all.json<{ id: string; fullName: string; specialty: string; avatarUrl: string; nextAvailableAt: string }[]>();
  assert.equal(doctors.length, 8);
  assert.ok(new Set(doctors.map((doctor) => doctor.specialty)).size >= 5);
  for (const term of [doctors[0].fullName.toUpperCase(), doctors[0].specialty.toLowerCase()]) {
    const response = await app.inject(prefix + '/doctors?search=' + encodeURIComponent(term));
    assert.ok(response.json<typeof doctors>().some(({ id }) => id === doctors[0].id));
  }
  const noMatch = await app.inject(prefix + '/doctors?search=%25');
  assert.deepEqual(noMatch.json(), []);
  const detail = await app.inject(prefix + '/doctors/' + doctors[0].id);
  assert.deepEqual(detail.json(), doctors[0]);
  assert.ok(Date.parse(doctors[0].nextAvailableAt) > seedNow);
  const avatar = await app.inject(doctors[0].avatarUrl);
  assert.equal(avatar.statusCode, 200);
  assert.match(avatar.headers['content-type'] ?? '', /^image\//);
  const patients = (await app.inject(prefix + '/patients')).json<{ id: string; isDemo: boolean }[]>();
  assert.equal(patients.length, 12);
  assert.deepEqual(patients.filter((patient) => patient.isDemo).map((patient) => patient.id), [demo]);
});

test('uses Tehran days and seeds the documented schedule scenarios', async (t) => {
  const { app, dbPath } = setup(t);
  const open = await slots(app);
  assert.ok(open.length > 0);
  assert.ok(open.every((slot) => slot.status === 'available'));
  assert.equal(open[0].startAt, '2026-11-26T05:30:00.000Z');
  assert.equal(Date.parse(open[0].endAt) - Date.parse(open[0].startAt), 30 * 60 * 1000);
  const full = await slots(app, 'doctor-02');
  assert.equal(full.length, open.length);
  assert.ok(full.every((slot) => slot.status === 'booked'));
  assert.deepEqual(await slots(app, 'doctor-03'), []);
  const late = await slots(app, doctor, '2026-12-09');
  assert.ok(late.length > 0);
  const past = await slots(app, doctor, '2026-11-24');
  assert.ok(past.some((slot) => slot.status === 'unavailable'));
  const dashboard = await app.inject(prefix + '/doctors/' + doctor + '/dashboard');
  assert.equal(dashboard.json().date, '2026-11-25');

  const db = new Database(dbPath, { readOnly: true });
  t.after(() => db.close());
  const distribution = db.prepare(`
    SELECT count(*) AS bookable, count(a.id) AS booked
    FROM time_slots AS s
    LEFT JOIN appointments AS a ON a.time_slot_id = s.id AND a.status <> 'cancelled'
    WHERE s.blocked = 0 AND s.start_at > ?
  `).get(seedNow)!;
  const bookedShare = Number(distribution.booked) / Number(distribution.bookable);
  assert.ok(bookedShare >= 0.25 && bookedShare <= 0.35, 'seed occupancy was ' + bookedShare);
  const history = (await app.inject(prefix + '/patients/' + demo + '/appointments')).json<Appointment[]>();
  assert.ok(history.some(({ status }) => status === 'completed'));
  assert.ok(history.some(({ status }) => status === 'cancelled'));
});

test('books through both views, cancels idempotently, and makes the slot bookable again', async (t) => {
  const { app } = setup(t);
  const [slot] = await slots(app);
  const created = await book(app, slot.id);
  assert.equal(created.statusCode, 201, created.body);
  const appointment = created.json<Appointment>();
  assert.equal(appointment.status, 'confirmed');
  assert.equal(appointment.doctor.id, doctor);
  assert.equal(appointment.patient.id, demo);
  assert.equal(appointment.timeSlot.id, slot.id);
  assert.equal(appointment.timeSlot.status, 'booked');
  assert.equal(appointment.reason, 'Fictional assessment visit');
  assert.equal(appointment.cancelledAt, null);

  const patientPath = prefix + '/patients/' + demo + '/appointments';
  const doctorPath = prefix + '/doctors/' + doctor + '/appointments';
  const patientView = await app.inject(patientPath + '?status=confirmed');
  assert.ok(patientView.json<Appointment[]>().some(({ id }) => id === appointment.id));
  const doctorView = await app.inject(doctorPath + '?date=' + tomorrow);
  assert.deepEqual(doctorView.json(), [appointment]);
  const otherDay = await app.inject(doctorPath + '?date=2026-11-25');
  assert.ok(!otherDay.json<Appointment[]>().some(({ id }) => id === appointment.id));
  const details = await app.inject(prefix + '/appointments/' + appointment.id);
  assert.deepEqual(details.json(), appointment);
  const dashboardUrl = prefix + '/doctors/' + doctor + '/dashboard?date=' + tomorrow;
  const before = (await app.inject(dashboardUrl)).json();
  assert.deepEqual(before.appointments, { total: 1, confirmed: 1, cancelled: 0, completed: 0 });
  assert.deepEqual(before.slots, { total: 12, available: 11, booked: 1, unavailable: 0 });

  const cancel = () => app.inject({ method: 'PATCH', url: prefix + '/appointments/' + appointment.id + '/cancel' });
  const cancelled = await cancel();
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json<Appointment>().status, 'cancelled');
  assert.equal(cancelled.json<Appointment>().cancelledAt, new Date(seedNow).toISOString());
  assert.deepEqual((await cancel()).json(), cancelled.json());
  assert.equal((await slots(app))[0].status, 'available');
  const after = (await app.inject(dashboardUrl)).json();
  assert.deepEqual(after.appointments, { total: 1, confirmed: 0, cancelled: 1, completed: 0 });
  assert.deepEqual(after.slots, { total: 12, available: 12, booked: 0, unavailable: 0 });
  const cancelledList = await app.inject(patientPath + '?status=cancelled');
  assert.ok(cancelledList.json<Appointment[]>().some(({ id }) => id === appointment.id));
  const rebooked = await book(app, slot.id);
  assert.equal(rebooked.statusCode, 201);
  assert.notEqual(rebooked.json<Appointment>().id, appointment.id);
  assert.equal((await cancel()).json<Appointment>().timeSlot.status, 'booked');
});

test('prevents concurrent and repeated bookings even through separate database connections', async (t) => {
  const { app, settings, dbPath } = setup(t);
  const otherApp = buildApp(settings);
  t.after(() => otherApp.close());
  const [slot] = await slots(app);
  const attempts = await Promise.all([book(app, slot.id), book(otherApp, slot.id, doctor, 'patient-02')]);
  assert.deepEqual(attempts.map((result) => result.statusCode).sort(), [201, 409]);
  const duplicate = await book(app, slot.id);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, 'SLOT_BOOKED');
  const results = await app.inject(prefix + '/doctors/' + doctor + '/appointments?date=' + tomorrow);
  assert.equal(results.json<Appointment[]>().length, 1);

  const db = new Database(dbPath);
  t.after(() => db.close());
  const insert = db.prepare(`
    INSERT INTO appointments (id, doctor_id, patient_id, time_slot_id, status, created_at)
    VALUES (?, ?, ?, ?, 'confirmed', ?)
  `);
  assert.throws(() => insert.run('duplicate', doctor, 'patient-03', slot.id, seedNow), /UNIQUE constraint failed/);
  const [, unusedSlot] = await slots(app);
  assert.throws(() => insert.run('wrong-doctor', 'doctor-02', demo, unusedSlot.id, seedNow), /FOREIGN KEY constraint failed/);
});

test('rejects blocked, past, missing, and wrong-doctor slots', async (t) => {
  const { app } = setup(t);
  const blocked = (await slots(app, 'doctor-04')).find((slot) => slot.status === 'unavailable');
  const past = (await slots(app, doctor, '2026-11-24')).find((slot) => slot.status === 'unavailable');
  assert.ok(blocked);
  assert.ok(past);
  for (const [slotId, doctorId, code] of [
    [blocked.id, 'doctor-04', 'SLOT_UNAVAILABLE'],
    [past.id, doctor, 'SLOT_IN_PAST'],
    [blocked.id, doctor, 'SLOT_DOCTOR_MISMATCH'],
  ]) {
    const result = await book(app, slotId, doctorId);
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, code);
  }
  const missing = await book(app, 'missing');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'SLOT_NOT_FOUND');
  const [open] = await slots(app);
  assert.equal((await book(app, open.id, 'missing')).json().error.code, 'DOCTOR_NOT_FOUND');
  assert.equal((await book(app, open.id, doctor, 'missing')).json().error.code, 'PATIENT_NOT_FOUND');
});

test('blocks cancellation after a slot starts and derives completion after it ends', async (t) => {
  let now = seedNow;
  const { app } = setup(t, { now: () => now });
  const [slot] = await slots(app);
  const created = (await book(app, slot.id)).json<Appointment>();
  const path = prefix + '/appointments/' + created.id;
  now = Date.parse(slot.startAt);
  const inProgress = await app.inject({ method: 'PATCH', url: path + '/cancel' });
  assert.equal(inProgress.statusCode, 409);
  assert.equal((await app.inject(path)).json<Appointment>().status, 'confirmed');
  now = Date.parse(slot.endAt);
  assert.equal((await app.inject(path)).json<Appointment>().status, 'completed');
  const completed = await app.inject(prefix + '/patients/' + demo + '/appointments?status=completed');
  assert.ok(completed.json<Appointment[]>().some(({ id }) => id === created.id));
  const dashboard = await app.inject(prefix + '/doctors/' + doctor + '/dashboard?date=' + tomorrow);
  assert.equal(dashboard.json().appointments.completed, 1);
  assert.equal((await app.inject({ method: 'PATCH', url: path + '/cancel' })).statusCode, 409);
});

test('persists writes across app restarts, resets exactly, and regenerates relative dates', async (t) => {
  const { app, settings, dbPath } = setup(t);
  const original = await slots(app);
  const created = await book(app, original[0].id);
  assert.equal(created.statusCode, 201);
  await app.close();

  const reopened = buildApp(settings);
  try {
    const detail = await reopened.inject(prefix + '/appointments/' + created.json<Appointment>().id);
    assert.deepEqual(detail.json(), created.json());
  } finally {
    await reopened.close();
  }

  const nextDay = seedNow + 86_400_000;
  assert.equal(resetDatabase(dbPath, 'reset', nextDay), '2026-11-25');
  const reset = buildApp(settings);
  try {
    assert.deepEqual(await slots(reset), original);
    assert.equal((await reset.inject(prefix + '/appointments/' + created.json<Appointment>().id)).statusCode, 404);
  } finally {
    await reset.close();
  }
  assert.equal(resetDatabase(dbPath, 'seed', nextDay), '2026-11-26');
  const reseeded = buildApp({ ...settings, now: () => nextDay });
  try {
    const newSlots = await slots(reseeded, doctor, '2026-11-27');
    assert.deepEqual(newSlots.map(({ id, status }) => ({ id, status })), original.map(({ id, status }) => ({ id, status })));
    assert.equal(Date.parse(newSlots[0].startAt) - Date.parse(original[0].startAt), 86_400_000);
  } finally {
    await reseeded.close();
  }
});

test('validates request inputs and returns safe, consistent errors', async (t) => {
  const { app } = setup(t);
  const broken = await app.inject({
    method: 'POST', url: prefix + '/appointments',
    headers: { 'content-type': 'application/json' }, payload: '{',
  });
  assert.equal(broken.statusCode, 400);
  assert.equal(broken.json().error.code, 'MALFORMED_REQUEST');
  for (const path of [
    '/doctors/' + doctor + '/availability',
    '/doctors/' + doctor + '/availability?date=2026-02-30',
    '/patients/' + demo + '/appointments?status=bad',
    '/doctors?search=hi&search=there',
    '/doctors?unexpected=1',
  ]) {
    const response = await app.inject(prefix + path);
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    assert.ok(response.json().error.details.length > 0);
  }
  const invalid = await app.inject({
    method: 'POST', url: prefix + '/appointments',
    payload: { doctorId: doctor, patientId: demo, timeSlotId: 123 },
  });
  assert.equal(invalid.statusCode, 422);
  const absent = await app.inject(prefix + '/doctors/missing/appointments');
  assert.equal(absent.statusCode, 404);
  assert.equal(absent.json().error.code, 'DOCTOR_NOT_FOUND');
});

test('simulates only the selected operation and keeps health and docs available', async (t) => {
  const { app } = setup(t, { simulation: { mode: 'error', operation: 'bookAppointment' } });
  const [slot] = await slots(app);
  const error = await book(app, slot.id);
  assert.equal(error.statusCode, 500);
  assert.deepEqual(error.json(), { error: { code: 'SIMULATED_SERVER_ERROR', message: 'Simulated server error.' } });
  assert.equal((await slots(app))[0].status, 'available');
  assert.equal((await app.inject(prefix + '/health')).statusCode, 200);
  assert.equal((await app.inject('/docs/')).statusCode, 200);
  const empty = setup(t, { simulation: { mode: 'empty', operation: 'getAvailability' } }).app;
  assert.deepEqual(await slots(empty), []);
  assert.equal((await empty.inject(prefix + '/doctors/' + doctor + '/availability?date=invalid')).statusCode, 422);
  assert.equal((await empty.inject(prefix + '/doctors/missing/availability?date=' + tomorrow)).statusCode, 404);
  assert.equal((await empty.inject(prefix + '/doctors')).json().length, 8);
});

test('loads organizer configuration and applies default latency to API requests', async (t) => {
  const defaults = readConfig({});
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 3001);
  assert.equal(defaults.latencyMs, 300);
  assert.equal(defaults.simulation, undefined);
  const custom = readConfig({
    HOST: '0.0.0.0', PORT: '8080', LATENCY_MS: '0', CORS_ORIGINS: 'http://localhost:3000',
    SIMULATION_MODE: 'empty', SIMULATION_OPERATION: 'listPatients',
  });
  assert.equal(custom.host, '0.0.0.0');
  assert.equal(custom.port, 8080);
  assert.equal(custom.latencyMs, 0);
  assert.deepEqual(custom.corsOrigins, ['http://localhost:3000']);
  assert.deepEqual(custom.simulation, { mode: 'empty', operation: 'listPatients' });
  assert.throws(() => readConfig({ SIMULATION_MODE: 'empty', SIMULATION_OPERATION: 'bookAppointment' }));
  assert.throws(() => readConfig({ CORS_ORIGINS: '*' }));

  const { app } = setup(t, { latencyMs: undefined });
  await app.ready();
  const start = performance.now();
  assert.equal((await app.inject(prefix + '/doctors')).statusCode, 200);
  assert.ok(performance.now() - start >= 280);
});

test('applies CORS and exposes documented routes and response examples', async (t) => {
  const { app } = setup(t, { corsOrigins: ['http://localhost:5173'] });
  const preflight = await app.inject({
    method: 'OPTIONS',
    url: prefix + '/appointments/some-id/cancel',
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'PATCH',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.match(preflight.headers['access-control-allow-methods'] ?? '', /PATCH/);
  const other = await app.inject({ url: prefix + '/doctors', headers: { origin: 'http://example.test' } });
  assert.equal(other.headers['access-control-allow-origin'], undefined);

  const openapi = await app.inject('/docs/json');
  assert.equal(openapi.statusCode, 200, openapi.body);
  const document = openapi.json();
  assert.equal(Object.keys(document.paths).length, 11);
  assert.ok(document.paths[prefix + '/appointments'].post.requestBody);
  assert.ok(document.paths[prefix + '/appointments'].post.responses['201'].content['application/json'].schema);
  assert.ok(document.paths[prefix + '/doctors/{id}/availability'].get.parameters.some(({ name }: { name: string }) => name === 'date'));
  assert.ok(Object.values(document.components.schemas).some((schema) => JSON.stringify(schema).includes('example')));
});
