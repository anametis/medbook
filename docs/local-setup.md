# Set up MediBook on your Mac

Run MediBook on your Mac for local testing or to give a candidate access from another computer on your network. The first start creates a SQLite database with fictional doctors, patients, and appointments.

## Install and start

1. Install Git and Node.js 26.12 or later in the 26.x release line. The version in [`.node-version`](../.node-version) is the version used for this project. Check your installation with `git --version`, `node --version`, and `npm --version`. [Node.js downloads](https://nodejs.org/en/download)
2. From Terminal, clone the repository and start the API. If you already have the project, open that folder and begin with `npm ci`.

   ```sh
   git clone https://github.com/anametis/medbook.git
   cd medbook
   npm ci
   test -f .env || cp .env.example .env
   npm start
   ```

3. Open [Swagger UI](http://127.0.0.1:3001/docs/) and try `GET /api/v1/health`. You can also check it from another Terminal window.

   ```sh
   curl -fsS http://127.0.0.1:3001/api/v1/health
   ```

   The response is `{"status":"ok"}`. Press **Control+C** in the server’s Terminal window to stop it.

## Configure the API

Edit `.env` in the project folder, then restart the server. [`.env.example`](../.env.example) shows the default configuration.

| Setting | Default | When to change it |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` when a candidate connects from another computer. |
| `PORT` | `3001` | Pick another port if `3001` is in use. Use the new port in all API and Swagger URLs. |
| `DB_PATH` | `./data/medibook.sqlite` | Set a different file path to keep a separate database for practice. |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Add the exact origin shown in the candidate’s browser if their React app uses a different host or port. Separate entries with commas and omit trailing slashes. |
| `LATENCY_MS` | `300` | Set `0` during setup or increase the value to test loading states. |

For normal assessments, use `SIMULATION_MODE=normal` and leave `SIMULATION_OPERATION` empty. To simulate a server error on booking, set `SIMULATION_MODE=error` and `SIMULATION_OPERATION=bookAppointment`. To return an empty daily schedule, use `SIMULATION_MODE=empty` and `SIMULATION_OPERATION=getAvailability`. Restart after each change. [Simulation options](../README.md#configuration-and-test-scenarios)

## Connect a candidate over the LAN

1. Connect both computers to the same local network and set `HOST=0.0.0.0` in `.env` on your Mac. Restart MediBook.
2. On your Mac, find the IPv4 address of the active Wi-Fi or Ethernet connection in **System Settings → Network**. For Wi-Fi on interface `en0`, you can also run `ipconfig getifaddr en0`.
3. Replace `192.168.1.20` with that address and share the API URL `http://192.168.1.20:3001/api/v1`, the Swagger URL `http://192.168.1.20:3001/docs/`, and the demo patient ID `patient-01`.
4. From the candidate’s computer, open `http://192.168.1.20:3001/api/v1/health` with your actual address. Then check that their React app can load doctors from the API. If the browser asks for local network access, allow it for their React development origin.

If health works on your Mac but times out on the candidate’s computer, check `HOST`, your current LAN address, the macOS firewall, and whether your Wi-Fi isolates devices. If health opens directly but the React app reports a CORS error, add the app’s exact origin to `CORS_ORIGINS` and restart.

## Restore the assessment data

Restarting the API preserves bookings. Stop the server before restoring fixtures and use the same `.env` and `DB_PATH` that serve the candidate.

| When | Command | Result |
| --- | --- | --- |
| Between candidates on the same day | `npm run db:reset` | Restores the original fixtures for the existing seed date. |
| Before assessments on a new day | `npm run db:seed` | Regenerates fixtures relative to today in Tehran. |

Both commands delete booking changes made since seeding. After running either command, run `npm start` again. Use tomorrow’s Tehran date on a fresh seed to see an open schedule for `doctor-01`, a fully booked schedule for `doctor-02`, and a day off for `doctor-03`.

Run `npm test` and `npm run typecheck` to check the local installation. The tests use their own temporary databases.
