# Development

Use a separate Firebase project for development. Configure the Firebase Emulator Suite for Auth, Firestore and Storage before developing workflows that write data. Do not add service-account JSON files to this repository; use secret injection or `GOOGLE_APPLICATION_CREDENTIALS` outside the repository.

Run `npm run typecheck`, `npm test`, and `npm run build` before a deploy. Windows agent build instructions are in `AGENT.md`; installer instructions are in `INSTALLER.md`.
