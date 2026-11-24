import type { FastifyInstance } from 'fastify';

export const id = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' };
export const date = { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$', examples: ['2026-11-26'] };
export const appointmentStatus = { type: 'string', enum: ['confirmed', 'cancelled', 'completed'] };
const slotStatus = { type: 'string', enum: ['available', 'booked', 'unavailable'] };
const string = { type: 'string' };
const timestamp = { type: 'string', format: 'date-time' };
const nullableTimestamp = { type: ['string', 'null'], format: 'date-time' };
const count = { type: 'integer', minimum: 0 };

export function object(properties: Record<string, object>, required = Object.keys(properties)) {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function array(items: object) {
  return { type: 'array', items };
}

export function ref(name: string) {
  return { $ref: name + '#' };
}

export function pathId(example: string) {
  return object({ id: { ...id, examples: [example] } });
}

function named(name: string, schema: object, example: object) {
  return { $id: name, title: name, ...schema, examples: [example] };
}

const doctorFields = {
  id, fullName: string, specialty: string, avatarUrl: string,
  biography: string, yearsOfExperience: count, location: string,
};
const doctorExample = {
  id: 'doctor-01', fullName: 'Leila Mehrvan', specialty: 'Family Medicine',
  avatarUrl: '/avatars/doctor-01',
  biography: 'Leila provides routine checkups and preventive care for adults and families.',
  yearsOfExperience: 12, location: 'North Clinic',
};
const patientExample = { id: 'patient-01', fullName: 'Roya Azarin', avatarUrl: '/avatars/patient-01', isDemo: true };
const slotExample = {
  id: 'slot-doctor-01-p1-1', doctorId: 'doctor-01', startAt: '2026-11-26T05:30:00.000Z',
  endAt: '2026-11-26T06:00:00.000Z', status: 'available',
};
const availabilityFields = {
  doctorId: id, date, timeZone: { type: 'string', const: 'Asia/Tehran' },
};
const availabilityExample = { doctorId: 'doctor-01', date: '2026-11-26', timeZone: 'Asia/Tehran' };
const bookingExample = {
  doctorId: 'doctor-01', patientId: 'patient-01', timeSlotId: slotExample.id, reason: 'Routine consultation',
};

export const bookingBody = {
  ...object({
    doctorId: { ...id, examples: [bookingExample.doctorId] },
    patientId: { ...id, examples: [bookingExample.patientId] },
    timeSlotId: { ...id, examples: [bookingExample.timeSlotId] },
    reason: { type: 'string', maxLength: 500, examples: [bookingExample.reason] },
  }, ['doctorId', 'patientId', 'timeSlotId']),
  examples: [bookingExample],
};

const errorDefinitions = {
  400: ['Malformed request', 'MALFORMED_REQUEST', 'Malformed request.'],
  404: ['Resource not found', 'DOCTOR_NOT_FOUND', 'Doctor not found.'],
  409: ['Booking or appointment state conflict', 'SLOT_BOOKED', 'The time slot is already booked.'],
  413: ['Payload too large', 'PAYLOAD_TOO_LARGE', 'Request payload is too large.'],
  415: ['Unsupported media type', 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported request content type.'],
  422: ['Input validation failed', 'VALIDATION_ERROR', 'Request validation failed.'],
  500: ['Server error', 'INTERNAL_ERROR', 'Unexpected server error.'],
} as const;

export function errorResponses(...statuses: (keyof typeof errorDefinitions)[]) {
  return Object.fromEntries(statuses.map((status) => {
    const [description, code, message] = errorDefinitions[status];
    return [status, { ...ref('ErrorResponse'), description, examples: [{ error: { code, message } }] }];
  }));
}

export function registerSchemas(app: FastifyInstance) {
  const schemas = [
    named('DoctorProfile', object(doctorFields), doctorExample),
    named('Doctor', object({ ...doctorFields, nextAvailableAt: nullableTimestamp }), {
      ...doctorExample, nextAvailableAt: slotExample.startAt,
    }),
    named('Patient', object({ id, fullName: string, avatarUrl: string, isDemo: { type: 'boolean' } }), patientExample),
    named('TimeSlot', object({ id, doctorId: id, startAt: timestamp, endAt: timestamp, status: slotStatus }), slotExample),
    named('Appointment', object({
      id, doctorId: id, patientId: id, timeSlotId: id, reason: { type: ['string', 'null'] },
      status: appointmentStatus, createdAt: timestamp, cancelledAt: nullableTimestamp,
      doctor: ref('DoctorProfile'), patient: ref('Patient'), timeSlot: ref('TimeSlot'),
    }), {
      id: 'e839fc0b-2756-47b7-83a3-7624ff77cc2c', ...bookingExample,
      status: 'confirmed', createdAt: '2026-11-25T07:00:00.000Z', cancelledAt: null,
      doctor: doctorExample, patient: patientExample, timeSlot: { ...slotExample, status: 'booked' },
    }),
    named('Availability', object({ ...availabilityFields, slots: array(ref('TimeSlot')) }), {
      ...availabilityExample, slots: [slotExample],
    }),
    named('Dashboard', object({
      ...availabilityFields,
      appointments: object({ total: count, confirmed: count, cancelled: count, completed: count }),
      slots: object({ total: count, available: count, booked: count, unavailable: count }),
    }), {
      ...availabilityExample,
      appointments: { total: 1, confirmed: 1, cancelled: 0, completed: 0 },
      slots: { total: 12, available: 11, booked: 1, unavailable: 0 },
    }),
    named('Health', object({ status: { type: 'string', const: 'ok' } }), { status: 'ok' }),
    named('ErrorResponse', object({
      error: object({ code: string, message: string, details: array(object({ field: string, message: string })) }, ['code', 'message']),
    }), { error: {
      code: 'VALIDATION_ERROR', message: 'Request validation failed.',
      details: [{ field: 'query.date', message: 'must be a valid date in YYYY-MM-DD format' }],
    } }),
  ];
  for (const schema of schemas) app.addSchema(schema);
}
