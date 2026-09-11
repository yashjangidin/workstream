# Architecture

The employer web client authenticates with Firebase Auth and sends its ID token to the Cloud Run API. The API verifies the token using Firebase Admin, derives the company from membership records, and performs all privileged Firestore and Storage operations. Clients never submit an authoritative company, employee, or device identity.

The Windows agent enrolls once with an employee setup code. The API stores only a salted hash of that code and returns a device credential. The agent stores that credential using Windows DPAPI, persists a bounded local SQLite outbox, and retries idempotent operations. Browser extension communication is localhost-only and authenticated by a rotating pairing secret.

Firestore holds operational metadata and Cloud Storage holds screenshot objects. The `@workstream/domain` package is the sole owner of duration, daily aggregation, classification, and alert-deduplication calculations. Both reports and dashboards consume those outputs.

## Trust boundaries

Employer browser -> Firebase Auth -> Cloud Run API -> Firestore/Storage

Windows agent -> Device credential -> Cloud Run API -> Firestore/Storage

Browser extension -> authenticated localhost bridge -> Windows agent

Firestore client rules deny direct writes to security-sensitive collections; privileged writes originate at the API.
