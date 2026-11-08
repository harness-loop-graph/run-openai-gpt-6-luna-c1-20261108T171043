# Medical Appointments & Clinical History

## Run locally

Copy `.env.example` to `.env`, then run `docker compose up --build`. PostgreSQL is published on 5432, the NestJS API on http://localhost:3000 and the SPA on http://localhost:8080. The backend runs versioned migrations and deterministic seed data at startup. Default local account password is configured by `SEED_PASSWORD` (default `Seed!Passw0rd`).

## Tests and formatting

Run `cd backend && npm test`, `cd frontend && npm run build`, and root `npm install && npx playwright test` against the running Compose stack. Each package contains `format` and `format:check` scripts.

## Seed users

`admin@seed.local`, `staff@seed.local`, `paciente1@seed.local` through `paciente3@seed.local`, `gomez@seed.local`, and `lopez@seed.local` use the configured seed password.
