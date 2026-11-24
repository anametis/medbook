CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY NOT NULL,
  full_name TEXT NOT NULL,
  specialty TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  biography TEXT NOT NULL,
  years_of_experience INTEGER NOT NULL CHECK (years_of_experience >= 0),
  location TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY NOT NULL,
  full_name TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  is_demo INTEGER NOT NULL CHECK (is_demo IN (0, 1))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_demo_patient
  ON patients(is_demo) WHERE is_demo = 1;

CREATE TABLE IF NOT EXISTS time_slots (
  id TEXT PRIMARY KEY NOT NULL,
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK (end_at - start_at = 1800000),
  blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
  UNIQUE (doctor_id, id),
  UNIQUE (doctor_id, start_at)
) STRICT;

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY NOT NULL,
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  time_slot_id TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  FOREIGN KEY (doctor_id, time_slot_id) REFERENCES time_slots(doctor_id, id),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (cancelled_at IS NULL OR cancelled_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_booking_per_slot
  ON appointments(time_slot_id) WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS appointments_by_doctor ON appointments(doctor_id);
CREATE INDEX IF NOT EXISTS appointments_by_patient ON appointments(patient_id);

CREATE TABLE IF NOT EXISTS seed_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  clinic_date TEXT NOT NULL
) STRICT;
