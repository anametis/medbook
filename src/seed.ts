import type { DatabaseSync as Database } from 'node:sqlite';
import { clinicTimestamp } from './clinic-time.ts';

const doctorFixtures = [
  ['Leila Mehrvan', 'Family Medicine', 'Leila provides routine checkups and preventive care for adults and families.', 12, 'North Clinic'],
  ['Arman Daryani', 'Cardiology', 'Arman sees adults for heart health consultations and follow-up visits.', 15, 'Central Clinic'],
  ['Nika Roshanfar', 'Dermatology', 'Nika provides general skin consultations and routine follow-ups.', 8, 'North Clinic'],
  ['Pouya Mehrabi', 'Orthopedics', 'Pouya helps patients plan care for joint concerns and everyday injuries.', 11, 'West Clinic'],
  ['Sara Navidian', 'Pediatrics', 'Sara provides routine wellness visits and follow-up care for children.', 9, 'Central Clinic'],
  ['Mina Roshani', 'Ophthalmology', 'Mina provides eye health consultations and routine vision checks.', 17, 'West Clinic'],
  ['Kian Darvishi', 'Family Medicine', 'Kian focuses on preventive care and continuity for adult patients.', 7, 'North Clinic'],
  ['Tara Nikmehr', 'Dermatology', 'Tara sees patients for routine skin checks and follow-up care.', 13, 'Central Clinic'],
] as const;

const patientFixtures = [
  'Roya Azarin', 'Nima Razavi', 'Setareh Vahidi', 'Ali Mehrasa',
  'Yasmin Nezami', 'Omid Kavyani', 'Laleh Arasteh', 'Dara Farzan',
  'Hasti Samadi', 'Peyman Nikzad', 'Niloufar Madani', 'Ramin Salarian',
];

function fixtureId(kind: 'doctor' | 'patient', index: number) {
  return kind + '-' + String(index + 1).padStart(2, '0');
}

function avatarUrl(id: string) {
  return '/avatars/' + id;
}

export function avatarName(id: string) {
  return avatarNames.get(id);
}

const avatarNames = new Map([
  ...doctorFixtures.map(([name], index) => [fixtureId('doctor', index), name] as const),
  ...patientFixtures.map((name, index) => [fixtureId('patient', index), name] as const),
]);

const minutesPerSlot = 30;
const slotMinutes = [540, 570, 600, 630, 660, 690, 780, 810, 840, 870, 900, 930];
const reasons = ['Routine consultation', 'Follow-up visit', 'General checkup'];

export function seedData(db: Database, anchor: Temporal.PlainDate) {
  db.exec('DELETE FROM appointments; DELETE FROM time_slots; DELETE FROM patients; DELETE FROM doctors;');
  const insertDoctor = db.prepare('INSERT INTO doctors VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertPatient = db.prepare('INSERT INTO patients VALUES (?, ?, ?, ?)');
  const insertSlot = db.prepare('INSERT INTO time_slots VALUES (?, ?, ?, ?, ?)');
  const insertAppointment = db.prepare('INSERT INTO appointments VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

  doctorFixtures.forEach(([name, specialty, biography, years, location], index) => {
    const id = fixtureId('doctor', index);
    insertDoctor.run(id, name, specialty, avatarUrl(id), biography, years, location);
  });
  patientFixtures.forEach((name, index) => {
    const id = fixtureId('patient', index);
    insertPatient.run(id, name, avatarUrl(id), Number(index === 0));
  });

  for (let offset = -7; offset <= 14; offset++) {
    const date = anchor.add({ days: offset });
    for (let doctorIndex = 0; doctorIndex < doctorFixtures.length; doctorIndex++) {
      if (offset === 1 && doctorIndex === 2) continue;

      const doctorId = fixtureId('doctor', doctorIndex);
      const scenarioDay = offset === 1 && doctorIndex < 2;
      for (const [slotIndex, minutes] of slotMinutes.entries()) {
        const slotId = 'slot-' + doctorId + '-' + (offset < 0 ? 'm' : 'p') + Math.abs(offset) + '-' + (slotIndex + 1);
        const startAt = clinicTimestamp(date, Math.floor(minutes / 60), minutes % 60);
        const endAt = startAt + minutesPerSlot * 60_000;
        const blocked = !scenarioDay && slotIndex === slotMinutes.length - 1;
        insertSlot.run(slotId, doctorId, startAt, endAt, Number(blocked));
        if (blocked) continue;

        const pattern = ((offset + 7) * 13 + doctorIndex * 7 + slotIndex * 3) % 10;
        const booked = scenarioDay ? doctorIndex === 1 : pattern < 3;
        const cancelled = !scenarioDay && pattern === 3 && (offset < 0 || offset === 2);
        if (!booked && !cancelled) continue;

        const patientIndex = ((offset + 7) * 2 + doctorIndex + slotIndex) % patientFixtures.length;
        const patientId = fixtureId('patient', patientIndex);
        const status = cancelled ? 'cancelled' : offset < 0 ? 'completed' : 'confirmed';
        const createdAt = clinicTimestamp(date.subtract({ days: 8 }), 9);
        const cancelledAt = cancelled ? clinicTimestamp(date.subtract({ days: 7 }), 9) : null;
        insertAppointment.run(
          'appointment-' + slotId, doctorId, patientId, slotId,
          reasons[slotIndex % reasons.length], status, createdAt, cancelledAt,
        );
      }
    }
  }
  db.prepare('INSERT OR REPLACE INTO seed_metadata (id, clinic_date) VALUES (1, ?)').run(anchor.toString());
}
