# Workstream

Workstream is a privacy-bounded employee time and optional activity-monitoring product. It has an employer web application, a Windows employee agent, a Cloud Run API, Firebase Authentication, Firestore, and Cloud Storage.

## Product invariants

- Effective work is always `timer duration - idle duration`.
- Productivity is separate from effective work and never reduces it.
- Monitoring exists only while both the timer and Active Monitoring are on.
- The agent never collects keystrokes, clipboard data, audio, video, passwords, form fields, or page content.
- A setup code is a one-employee credential: it is hashed at rest and shown in plaintext only at creation/regeneration.

## Repository map

`apps/employer-web` is the employer dashboard. `services/api` is the Cloud Run API. `packages/domain` owns calculation and classification invariants. `packages/shared-types` owns API-safe contracts. `apps/employee-agent` is the Windows WinForms agent. Infrastructure rules, installer assets, browser-extension source, documentation and tests are included in their corresponding folders.

## Local development

1. Copy `.env.example` to `.env` and set Firebase development credentials.
2. Run `npm install` at this directory.
3. Run `npm run dev:api` and `npm run dev:web` in separate terminals.

The API deliberately refuses credentialed production use until Firebase Admin configuration is present. See [DEVELOPMENT.md](DEVELOPMENT.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [SECURITY.md](SECURITY.md).
