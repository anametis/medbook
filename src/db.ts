import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync as Database } from 'node:sqlite';
import { clinicDate, clinicDayRange } from './clinic-time.ts';
import { ApiError } from './errors.ts';
import { seedData } from './seed.ts';

type DoctorRow = {
  id: string;
  full_name: string;
  specialty: string;
  avatar_url: string;
  biography: string;
  years_of_experience: number;
  location: string;
};

type PatientRow = { id: string; full_name: string; avatar_url: string; is_demo: number };

type SlotRow = {
  id: string;
  doctor_id: string;
  start_at: number;
  end_at: number;
  blocked: number;
  occupied: number;
};

export type AppointmentStatus = 'confirmed' | 'cancelled' | 'completed';
export type Booking = { doctorId: string; patientId: string; timeSlotId: string; reason?: string };

type AppointmentRow = {
  id: string;
  doctor_id: string;
  patient_id: string;
  reason: string | null;
  status: AppointmentStatus;
  created_at: number;
  cancelled_at: number | null;
  slot_id: string;
  start_at: number;
  end_at: number;
  blocked: number;
  occupied: number;
  doctor_name: string;
  specialty: string;
  doctor_avatar: string;
  biography: string;
  years_of_experience: number;
  location: string;
  patient_name: string;
  patient_avatar: string;
  is_demo: number;
};

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

function transaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    db.exec(schema);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function storedSeedDate(db: Database) {
  const row = db.prepare('SELECT clinic_date FROM seed_metadata WHERE id = 1').get();
  return row ? Temporal.PlainDate.from(row.clinic_date as string) : undefined;
}

export function resetDatabase(path: string, action: 'reset' | 'seed', now = Date.now()) {
  const db = openDatabase(path);
  try {
    return transaction(db, () => {
      const date = (action === 'reset' ? storedSeedDate(db) : undefined) ?? clinicDate(now);
      seedData(db, date);
      return date.toString();
    });
  } finally {
    db.close();
  }
}

function doctorProfile(row: DoctorRow) {
  return {
    id: row.id,
    fullName: row.full_name,
    specialty: row.specialty,
    avatarUrl: row.avatar_url,
    biography: row.biography,
    yearsOfExperience: row.years_of_experience,
    location: row.location,
  };
}

function patientProfile(row: PatientRow) {
  return { id: row.id, fullName: row.full_name, avatarUrl: row.avatar_url, isDemo: Boolean(row.is_demo) };
}

function slotStatus(row: SlotRow, now: number): 'booked' | 'unavailable' | 'available' {
  if (row.occupied) return 'booked';
  if (row.blocked || row.start_at <= now) return 'unavailable';
  return 'available';
}

function timeSlot(row: SlotRow, now: number) {
  return {
    id: row.id,
    doctorId: row.doctor_id,
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    status: slotStatus(row, now),
  };
}

function appointment(row: AppointmentRow, now: number) {
  const status = row.status === 'confirmed' && row.end_at <= now ? 'completed' : row.status;
  return {
    id: row.id,
    doctorId: row.doctor_id,
    patientId: row.patient_id,
    timeSlotId: row.slot_id,
    reason: row.reason,
    status,
    createdAt: new Date(row.created_at).toISOString(),
    cancelledAt: row.cancelled_at === null ? null : new Date(row.cancelled_at).toISOString(),
    doctor: doctorProfile({
      ...row, id: row.doctor_id, full_name: row.doctor_name, avatar_url: row.doctor_avatar,
    }),
    patient: patientProfile({
      ...row, id: row.patient_id, full_name: row.patient_name, avatar_url: row.patient_avatar,
    }),
    timeSlot: timeSlot({ ...row, id: row.slot_id }, now),
  };
}

const doctorSelect = `
  SELECT d.*, (
    SELECT MIN(s.start_at) FROM time_slots AS s
    WHERE s.doctor_id = d.id AND s.start_at > ? AND s.blocked = 0
      AND NOT EXISTS (
        SELECT 1 FROM appointments AS a WHERE a.time_slot_id = s.id AND a.status <> 'cancelled'
      )
  ) AS next_available_at
  FROM doctors AS d
`;

const slotSelect = `
  SELECT s.*, active.id IS NOT NULL AS occupied
  FROM time_slots AS s
  LEFT JOIN appointments AS active ON active.time_slot_id = s.id AND active.status <> 'cancelled'
`;

const appointmentSelect = `
  SELECT a.*, s.id AS slot_id, s.start_at, s.end_at, s.blocked,
    active.id IS NOT NULL AS occupied,
    d.full_name AS doctor_name, d.specialty, d.avatar_url AS doctor_avatar,
    d.biography, d.years_of_experience, d.location,
    p.full_name AS patient_name, p.avatar_url AS patient_avatar, p.is_demo
  FROM appointments AS a
  JOIN time_slots AS s ON s.id = a.time_slot_id
  JOIN doctors AS d ON d.id = a.doctor_id
  JOIN patients AS p ON p.id = a.patient_id
  LEFT JOIN appointments AS active ON active.time_slot_id = s.id AND active.status <> 'cancelled'
`;

type DoctorWithAvailability = DoctorRow & { next_available_at: number | null };

function doctorWithAvailability(row: DoctorWithAvailability) {
  return {
    ...doctorProfile(row),
    nextAvailableAt: row.next_available_at === null ? null : new Date(row.next_available_at).toISOString(),
  };
}

export class Store {
  private readonly db: Database;

  constructor(path: string, now: number) {
    const db = openDatabase(path);
    try {
      transaction(db, () => {
        if (!storedSeedDate(db)) seedData(db, clinicDate(now));
      });
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  close() {
    this.db.close();
  }

  health() {
    this.db.prepare('SELECT id FROM seed_metadata WHERE id = 1').get();
  }

  doctors(now: number, search = '') {
    const term = search.trim().toLowerCase();
    const rows = this.db.prepare(doctorSelect + 'ORDER BY d.full_name, d.id').all(now) as DoctorWithAvailability[];
    return rows
      .filter((row) => row.full_name.toLowerCase().includes(term) || row.specialty.toLowerCase().includes(term))
      .map(doctorWithAvailability);
  }

  doctor(id: string, now: number) {
    const row = this.db.prepare(doctorSelect + 'WHERE d.id = ?').get(now, id) as DoctorWithAvailability | undefined;
    if (!row) throw new ApiError(404, 'DOCTOR_NOT_FOUND', 'Doctor not found.');
    return doctorWithAvailability(row);
  }

  patients() {
    return (this.db.prepare('SELECT * FROM patients ORDER BY id').all() as PatientRow[]).map(patientProfile);
  }

  private requireDoctor(id: string) {
    if (!this.db.prepare('SELECT 1 FROM doctors WHERE id = ?').get(id)) {
      throw new ApiError(404, 'DOCTOR_NOT_FOUND', 'Doctor not found.');
    }
  }

  private requirePatient(id: string) {
    if (!this.db.prepare('SELECT 1 FROM patients WHERE id = ?').get(id)) {
      throw new ApiError(404, 'PATIENT_NOT_FOUND', 'Patient not found.');
    }
  }

  availability(doctorId: string, date: Temporal.PlainDate, now: number) {
    this.requireDoctor(doctorId);
    const rows = this.db.prepare(slotSelect + `
      WHERE s.doctor_id = ? AND s.start_at >= ? AND s.start_at < ? ORDER BY s.start_at
    `).all(doctorId, ...clinicDayRange(date)) as SlotRow[];
    return rows.map((row) => timeSlot(row, now));
  }

  patientAppointments(patientId: string, now: number, status?: AppointmentStatus) {
    this.requirePatient(patientId);
    const rows = this.db.prepare(appointmentSelect + `
      WHERE a.patient_id = ? ORDER BY s.start_at DESC, a.created_at DESC, a.id
    `).all(patientId) as AppointmentRow[];
    return rows.map((row) => appointment(row, now)).filter((item) => status === undefined || item.status === status);
  }

  doctorAppointments(doctorId: string, now: number, date?: Temporal.PlainDate) {
    this.requireDoctor(doctorId);
    const sql = appointmentSelect + 'WHERE a.doctor_id = ? ';
    const order = 'ORDER BY s.start_at, a.created_at, a.id';
    const rows = (date
      ? this.db.prepare(sql + 'AND s.start_at >= ? AND s.start_at < ? ' + order).all(doctorId, ...clinicDayRange(date))
      : this.db.prepare(sql + order).all(doctorId)) as AppointmentRow[];
    return rows.map((row) => appointment(row, now));
  }

  private appointmentRow(id: string) {
    const row = this.db.prepare(appointmentSelect + 'WHERE a.id = ?').get(id) as AppointmentRow | undefined;
    if (!row) throw new ApiError(404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found.');
    return row;
  }

  getAppointment(id: string, now: number) {
    return appointment(this.appointmentRow(id), now);
  }

  book(booking: Booking, clock: () => number) {
    return transaction(this.db, () => {
      const now = clock();
      const { doctorId, patientId, timeSlotId, reason } = booking;
      this.requireDoctor(doctorId);
      this.requirePatient(patientId);
      const slot = this.db.prepare(slotSelect + 'WHERE s.id = ?').get(timeSlotId) as SlotRow | undefined;
      if (!slot) throw new ApiError(404, 'SLOT_NOT_FOUND', 'Time slot not found.');
      if (slot.doctor_id !== doctorId) {
        throw new ApiError(409, 'SLOT_DOCTOR_MISMATCH', 'The time slot belongs to another doctor.');
      }
      if (slot.start_at <= now) throw new ApiError(409, 'SLOT_IN_PAST', 'The time slot has already started.');
      if (slot.blocked) throw new ApiError(409, 'SLOT_UNAVAILABLE', 'The time slot is unavailable.');
      if (slot.occupied) throw new ApiError(409, 'SLOT_BOOKED', 'The time slot is already booked.');

      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO appointments (id, doctor_id, patient_id, time_slot_id, reason, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'confirmed', ?)
      `).run(id, doctorId, patientId, timeSlotId, reason?.trim() || null, now);
      return this.getAppointment(id, now);
    });
  }

  cancel(id: string, clock: () => number) {
    return transaction(this.db, () => {
      const now = clock();
      const row = this.appointmentRow(id);
      if (row.status === 'cancelled') return appointment(row, now);
      if (row.status === 'completed' || row.start_at <= now) {
        throw new ApiError(409, 'APPOINTMENT_NOT_CANCELLABLE', 'Only future appointments can be cancelled.');
      }

      this.db.prepare(`UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(now, id);
      return this.getAppointment(id, now);
    });
  }
}
