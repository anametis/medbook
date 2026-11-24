export const clinicTimeZone = 'Asia/Tehran';

export function clinicDate(now: number) {
  return Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(clinicTimeZone).toPlainDate();
}

export function clinicTimestamp(date: Temporal.PlainDate, hour = 0, minute = 0) {
  return date.toZonedDateTime({
    timeZone: clinicTimeZone,
    plainTime: new Temporal.PlainTime(hour, minute),
  }).epochMilliseconds;
}

export function clinicDayRange(date: Temporal.PlainDate) {
  return [clinicTimestamp(date), clinicTimestamp(date.add({ days: 1 }))] as const;
}
