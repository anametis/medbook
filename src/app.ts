import { setTimeout as delay } from 'node:timers/promises';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifySchema, type FastifySchemaValidationError } from 'fastify';
import { clinicDate, clinicTimeZone } from './clinic-time.ts';
import { defaultCorsOrigins, type Simulation } from './config.ts';
import { Store, type AppointmentStatus, type Booking } from './db.ts';
import { ApiError } from './errors.ts';
import {
  appointmentStatus, array, bookingBody, date, errorResponses, object, pathId, ref, registerSchemas,
} from './schemas.ts';
import { avatarName } from './seed.ts';

export type AppOptions = {
  dbPath: string;
  now?: () => number;
  latencyMs?: number;
  corsOrigins?: string[];
  simulation?: Simulation;
  logger?: boolean;
};

type RouteSpec = FastifySchema & { operationId: string; summary: string; tags: string[] };
type RequestError = Error & {
  statusCode?: number;
  validation?: FastifySchemaValidationError[];
  validationContext?: string;
};

function route(
  operationId: string,
  summary: string,
  tag: string,
  result: object,
  options: {
    params?: object; querystring?: object; body?: object; created?: boolean; missing?: boolean; conflict?: boolean;
  } = {},
): RouteSpec {
  const { created, missing, conflict, ...input } = options;
  return {
    operationId, summary, tags: [tag], querystring: object({}), ...input,
    response: {
      [created ? 201 : 200]: result,
      ...errorResponses(400, 422, 500),
      ...(options.body ? errorResponses(413, 415) : {}),
      ...(missing ? errorResponses(404) : {}),
      ...(conflict ? errorResponses(409) : {}),
    },
  };
}

function parseDate(value: string) {
  try {
    return Temporal.PlainDate.from(value);
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Request validation failed.', [
      { field: 'query.date', message: 'must be a valid date in YYYY-MM-DD format' },
    ]);
  }
}

function appointmentsStats(appointments: ReturnType<Store['doctorAppointments']>) {
  const counts = { total: appointments.length, confirmed: 0, cancelled: 0, completed: 0 };
  for (const appointment of appointments) counts[appointment.status]++;
  return counts;
}

function slotsStats(slots: ReturnType<Store['availability']>) {
  const counts = { total: slots.length, available: 0, booked: 0, unavailable: 0 };
  for (const slot of slots) counts[slot.status]++;
  return counts;
}

function registerRoutes(
  app: FastifyInstance, store: Store, clock: () => number, latencyMs: number, simulation?: Simulation,
) {
  app.addHook('onRequest', async (request) => {
    const schema = request.routeOptions.schema as RouteSpec | undefined;
    if (schema?.operationId !== 'getHealth' && latencyMs > 0) await delay(latencyMs);
  });

  app.addHook('preHandler', async (request) => {
    const schema = request.routeOptions.schema as RouteSpec | undefined;
    if (schema?.operationId === 'cancelAppointment' && request.body !== undefined) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Request validation failed.', [
        { field: 'body', message: 'must be omitted when cancelling an appointment' },
      ]);
    }
    if (simulation?.mode === 'error' && simulation.operation === schema?.operationId) {
      throw new ApiError(500, 'SIMULATED_SERVER_ERROR', 'Simulated server error.');
    }
  });

  function list<T>(operation: string, values: T[]): T[] {
    return simulation?.mode === 'empty' && simulation.operation === operation ? [] : values;
  }

  app.get<{ Querystring: { search?: string } }>('/doctors', {
    schema: route('listDoctors', 'List and search doctors', 'Doctors', array(ref('Doctor')), {
      querystring: object({ search: { type: 'string', maxLength: 100, examples: ['cardiology'] } }, []),
    }),
  }, (request) => list('listDoctors', store.doctors(clock(), request.query.search)));

  app.get<{ Params: { id: string } }>('/doctors/:id', {
    schema: route('getDoctor', 'Get a doctor profile', 'Doctors', ref('Doctor'), {
      params: pathId('doctor-01'), missing: true,
    }),
  }, (request) => store.doctor(request.params.id, clock()));

  app.get<{ Params: { id: string }; Querystring: { date: string } }>('/doctors/:id/availability', {
    schema: route('getAvailability', 'Get the slots for a Tehran clinic day', 'Doctors', ref('Availability'), {
      params: pathId('doctor-01'), querystring: object({ date }), missing: true,
    }),
  }, (request) => {
    const doctorId = request.params.id;
    const day = parseDate(request.query.date);
    return {
      doctorId, date: day.toString(), timeZone: clinicTimeZone,
      slots: list('getAvailability', store.availability(doctorId, day, clock())),
    };
  });

  app.get('/patients', {
    schema: route('listPatients', 'List mock patients and the demo patient', 'Patients', array(ref('Patient'))),
  }, () => list('listPatients', store.patients()));

  app.get<{ Params: { id: string }; Querystring: { status?: AppointmentStatus } }>('/patients/:id/appointments', {
    schema: route('listPatientAppointments', 'List a patient’s appointments', 'Patients', array(ref('Appointment')), {
      params: pathId('patient-01'),
      querystring: object({ status: { ...appointmentStatus, examples: ['confirmed'] } }, []),
      missing: true,
    }),
  }, (request) => list('listPatientAppointments', store.patientAppointments(
    request.params.id, clock(), request.query.status,
  )));

  app.get<{ Params: { id: string }; Querystring: { date?: string } }>('/doctors/:id/appointments', {
    schema: route('listDoctorAppointments', 'List a doctor’s appointments', 'Doctors', array(ref('Appointment')), {
      params: pathId('doctor-01'), querystring: object({ date }, []), missing: true,
    }),
  }, (request) => {
    const day = request.query.date === undefined ? undefined : parseDate(request.query.date);
    return list('listDoctorAppointments', store.doctorAppointments(request.params.id, clock(), day));
  });

  app.get<{ Params: { id: string } }>('/appointments/:id', {
    schema: route('getAppointment', 'Get an appointment and its related records', 'Appointments', ref('Appointment'), {
      params: pathId('e839fc0b-2756-47b7-83a3-7624ff77cc2c'), missing: true,
    }),
  }, (request) => store.getAppointment(request.params.id, clock()));

  app.post<{ Body: Booking }>('/appointments', {
    schema: route('bookAppointment', 'Book an available future time slot', 'Appointments', ref('Appointment'), {
      body: bookingBody, created: true, missing: true, conflict: true,
    }),
  }, (request, reply) => reply.code(201).send(store.book(request.body, clock)));

  app.patch<{ Params: { id: string } }>('/appointments/:id/cancel', {
    schema: route('cancelAppointment', 'Cancel a future appointment', 'Appointments', ref('Appointment'), {
      params: pathId('e839fc0b-2756-47b7-83a3-7624ff77cc2c'), missing: true, conflict: true,
    }),
  }, (request) => store.cancel(request.params.id, clock));

  app.get<{ Params: { id: string }; Querystring: { date?: string } }>('/doctors/:id/dashboard', {
    schema: route('getDoctorDashboard', 'Get a doctor’s appointment and slot counts', 'Doctors', ref('Dashboard'), {
      params: pathId('doctor-01'), querystring: object({
        date: { ...date, description: 'Defaults to today in Asia/Tehran.' },
      }, []), missing: true,
    }),
  }, (request) => {
    const doctorId = request.params.id;
    const now = clock();
    const day = request.query.date === undefined ? clinicDate(now) : parseDate(request.query.date);
    const appointments = store.doctorAppointments(doctorId, now, day);
    const slots = store.availability(doctorId, day, now);
    return {
      doctorId, date: day.toString(), timeZone: clinicTimeZone,
      appointments: appointmentsStats(appointments),
      slots: slotsStats(slots),
    };
  });

  app.get('/health', {
    schema: route('getHealth', 'Check database connectivity', 'Health', ref('Health')),
  }, () => {
    store.health();
    return { status: 'ok' };
  });
}

export function buildApp(options: AppOptions) {
  const now = options.now ?? Date.now;
  const store = new Store(options.dbPath, now());
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });
  app.addHook('onClose', () => store.close());

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  app.setErrorHandler<RequestError>((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: {
        code: error.code, message: error.message, details: error.details,
      } });
    }
    if (error.validation) {
      const context = error.validationContext === 'querystring' ? 'query' : error.validationContext;
      const details = error.validation.map(({ instancePath, message, params }) => ({
        field: [context, ...instancePath.split('/').slice(1), params.missingProperty ?? params.additionalProperty]
          .filter(Boolean).join('.'),
        message: message ?? 'is invalid',
      }));
      return reply.code(422).send({ error: {
        code: 'VALIDATION_ERROR', message: 'Request validation failed.', details,
      } });
    }
    if (error.statusCode === 400) {
      return reply.code(400).send({ error: { code: 'MALFORMED_REQUEST', message: 'Malformed request.' } });
    }
    if (error.statusCode === 413) {
      return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request payload is too large.' } });
    }
    if (error.statusCode === 415) {
      return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request content type.' } });
    }
    request.log.error({ err: error }, 'Failed to handle request');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  });

  app.register(cors, {
    origin: options.corsOrigins ?? defaultCorsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });
  app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'MediBook Mock API', version: '1.0.0', description: 'Fictional clinic data for a frontend engineering assessment.' },
      servers: [{ url: '/', description: 'Current API host' }],
    },
  });
  app.register(swaggerUI, { routePrefix: '/docs' });

  registerSchemas(app);
  app.get<{ Params: { id: string } }>('/avatars/:id', {
    schema: { hide: true, params: pathId('doctor-01') },
  }, (request, reply) => {
    const name = avatarName(request.params.id);
    if (!name) throw new ApiError(404, 'AVATAR_NOT_FOUND', 'Avatar not found.');
    const initials = name.split(' ').map((part) => part[0]).join('');
    return reply.type('image/svg+xml').header('Cache-Control', 'public, max-age=3600').send(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' +
      '<rect width="80" height="80" rx="40" fill="#d9eeea"/>' +
      '<text x="40" y="49" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#124b43">' +
      initials + '</text></svg>',
    );
  });
  app.register(async (api) => {
    registerRoutes(api, store, now, options.latencyMs ?? 300, options.simulation);
  }, { prefix: '/api/v1' });
  return app;
}
