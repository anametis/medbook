# MediBook Mock API

MediBook provides fictional appointment data for a one day React assessment. The organizer runs the API and shares its LAN address with one candidate at a time. The patient and doctor IDs are assessment identities. Anyone who can reach the service can use them.

## Organizer setup

The [Mac setup and configuration guide](docs/local-setup.md) walks through cloning the project, running it on your computer, and preparing it for a LAN assessment.

Install Node.js 26.12 or newer from the 26.x release line and run these commands from this directory.

```sh
npm ci
cp .env.example .env
npm start
```

Open [Swagger UI](http://127.0.0.1:3001/docs/) on your computer. The generated [OpenAPI JSON](http://127.0.0.1:3001/docs/json) includes schemas and examples for all 11 API operations. Example dates in Swagger illustrate the format. Use dates from your current seed when trying the API.

For a LAN assessment, set `HOST=0.0.0.0` in `.env` and start the API. Find your computer’s LAN IPv4 address in its network settings and share the base URL and docs URL with the candidate, replacing `192.168.1.20` with that address.

- API base URL `http://192.168.1.20:3001/api/v1`
- Swagger UI `http://192.168.1.20:3001/docs/`
- Demo patient `patient-01`

Check `/api/v1/health` from the candidate’s PC before the assessment. If the request times out, check whether both computers are on the same LAN and whether your firewall allows incoming TCP connections on port 3001. Guest networks may isolate devices from each other. Use this service on the assessment LAN with fictional data.

### Reset between candidates

The first startup seeds the configured SQLite file. Regular restarts preserve appointments. Stop the server before running a maintenance command.

| Command | Effect |
| --- | --- |
| `npm run db:reset` | Restore the original fixtures and seed date. Use this between candidates on the same assessment day. |
| `npm run db:seed` | Replace the data with the same fixture pattern anchored to the current Tehran date. Use this when starting assessments on a new day. |

Start the server again with the same configuration for each candidate. Both commands use `DB_PATH` and replace appointment changes made since seeding. Reset uses the current date if it is run against a new database.

## Candidate quick start

1. Open the Swagger URL provided by the organizer. Run `GET /api/v1/health` to confirm connectivity.
2. Point your React app at the provided API base URL. Run the React development server at `http://localhost:5173` or `http://127.0.0.1:5173`. If you use a different host or port, give the organizer your exact browser origin so they can add it to `CORS_ORIGINS`.
3. Use `GET /patients` to find the demo patient marked `isDemo: true`. Use `GET /doctors` to populate your doctor switcher. Paths here are relative to the API base URL.
4. Send date filters as `YYYY-MM-DD` in `Asia/Tehran`. Timestamps are UTC ISO 8601, so format them in the clinic timezone for display. Resolve each `avatarUrl` against the API origin. For example, `new URL(avatarUrl, apiBaseUrl).href` works with the supplied root relative paths.

If your browser asks for local network access while your app is running, allow access for its local development origin.

### Book and cancel an appointment

Start with tomorrow’s Tehran date on a fresh seed. Doctor `doctor-01` has 12 open slots on that day. This example uses `curl`, `jq`, and a POSIX shell. You can also run the same requests in Swagger.

```sh
API='http://192.168.1.20:3001/api/v1' # Replace with your API base URL
DATE=$(TZ=Asia/Tehran node -p "new Date(Date.now() + 86400000).toLocaleDateString('en-CA')")
DOCTOR='doctor-01'
PATIENT='patient-01'

curl -fsS "$API/doctors?search=family"
AVAILABILITY=$(curl -fsS "$API/doctors/$DOCTOR/availability?date=$DATE")
SLOT=$(printf '%s' "$AVAILABILITY" | jq -er 'first(.slots[] | select(.status == "available") | .id)')

BOOKING=$(jq -nc --arg doctorId "$DOCTOR" --arg patientId "$PATIENT" --arg timeSlotId "$SLOT" \
  '{doctorId: $doctorId, patientId: $patientId, timeSlotId: $timeSlotId, reason: "Routine assessment visit"}')
CREATED=$(curl -fsS -H 'Content-Type: application/json' -d "$BOOKING" "$API/appointments")
APPOINTMENT=$(printf '%s' "$CREATED" | jq -er '.id')

curl -fsS "$API/patients/$PATIENT/appointments?status=confirmed"
curl -fsS "$API/doctors/$DOCTOR/appointments?date=$DATE"
curl -fsS "$API/doctors/$DOCTOR/dashboard?date=$DATE"
curl -fsS -X PATCH "$API/appointments/$APPOINTMENT/cancel"
curl -fsS "$API/doctors/$DOCTOR/availability?date=$DATE" |
  jq --arg id "$SLOT" '.slots[] | select(.id == $id) | .status'
```

Booking returns `201` and a confirmed appointment. Cancellation returns `200`, and the final request prints `"available"` while the slot is still in the future. A repeated cancellation preserves `cancelledAt`. The embedded time slot always shows its current status, including when someone rebooks it. Appointment responses include the related doctor, patient, and slot.

## Configuration and test scenarios

| Setting | Default | Behavior |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to listen on LAN interfaces. |
| `PORT` | `3001` | HTTP port. |
| `DB_PATH` | `./data/medibook.sqlite` | Database file used by the API and maintenance commands. |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma separated, exact browser origins without trailing slashes. |
| `LATENCY_MS` | `300` | Delay for API operations, except health and CORS preflight. Set to `0` for immediate responses. |
| `SIMULATION_MODE` | `normal` | Choose `normal`, `error`, or `empty`. |
| `SIMULATION_OPERATION` | Empty | Set one operation ID from Swagger for `error` or `empty`. Leave blank in normal mode. |

Change simulation settings on the organizer’s computer and restart the API. For example, set `SIMULATION_MODE=error` and `SIMULATION_OPERATION=bookAppointment` to get a deterministic `500 SIMULATED_SERVER_ERROR` on valid booking requests with no database write. Error mode supports every documented operation except `getHealth`. Empty mode supports `listDoctors`, `getAvailability`, `listPatients`, `listPatientAppointments`, and `listDoctorAppointments`. For availability, only the `slots` array becomes empty.

The seed includes eight doctors, twelve patients, the current clinic day plus 14 days ahead, and historical appointments. These scenarios work in normal mode.

| Scenario | Request or fixture |
| --- | --- |
| Open schedule with zero bookings | View `doctor-01` on the day after seeding. |
| Fully booked schedule | View `doctor-02` on the day after seeding. |
| Day off | View `doctor-03` on the day after seeding. |
| Blocked slot | View the last slot for `doctor-04` on the day after seeding. |
| Empty search | Search for a name or specialty absent from the seed. |
| Duplicate booking | Send a second booking for an already booked slot and inspect `409 SLOT_BOOKED`. |
| Invalid input | Pass an impossible date such as `2026-02-30` and inspect `422 VALIDATION_ERROR`. |
| Missing resource | Request `/doctors/missing` and inspect `404 DOCTOR_NOT_FOUND`. |
| Cancellation | Cancel a future appointment and check its slot again. |

Errors have the shape `{ "error": { "code": "...", "message": "...", "details": [] } }`. The `details` field appears with field level validation messages when available. An unoccupied past slot is unavailable. A booking that reaches its end time appears as completed without changing the slot’s booking history.

Run `npm test` for integration tests against temporary databases and `npm run typecheck` for the TypeScript check.
