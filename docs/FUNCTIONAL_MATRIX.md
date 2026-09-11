# Functional verification matrix

Status after the implementation pass (10 September 2026). A compile is not an end-to-end verification; rows marked partial are intentionally not presented as complete.

| Area | UI | API / Firestore | Business logic | Verification still required |
|---|---|---|---|---|
| Authentication | Existing | Existing | Existing | Session refresh and reset delivery |
| Employee creation | Functional page and setup-code flow | Persisted create/edit/delete/regenerate/revoke | Validated and audited | Live API smoke passed; provider delivery requires credentials |
| Edit, defaults, company settings | Functional forms | Persisted settings/config endpoint | Schedule validation | Live API smoke passed; browser rerun was credit-blocked |
| Enrollment and device credential | Windows pairing UI | Device enrollment/heartbeat/config/revoke | Hashed credential and idempotency | Live API smoke passed |
| Timer and idle | Durable Windows outbox | Session/idle APIs and recovery | Canonical merged totals | Live API smoke passed; real Windows GUI E2E unavailable |
| Dashboard / reports | Functional data-driven pages | Overview/reports endpoints | Shared timezone-aware engine | Live API smoke passed; weekly aggregation added |
| Activity / screenshots | Agent capture/queue and detail views | Upload/storage/read endpoints | Rule classification and retry/quarantine | Agent verification passed; real screenshot upload not run on Windows desktop |
| Alerts and providers | Filters/acknowledgement/settings | Dedupe/cooldown/jobs/delivery status | Idle/offline/late/target/nonproductive/report rules | Dashboard path implemented; external credentials unconfigured |
| Rules | CRUD/search UI | Scoped CRUD and agent classification | Employee > company > default | Domain unit tests passed |
| Corrections / jobs | Agent request and detail review | Request/review/adjustment/job endpoints | Approved adjustments feed reports | Typecheck/build passed; live correction review not smoke-tested |

Keep unresolved acceptance items explicit in the final handoff. No notification-provider secret is assumed configured. Live email and external notification delivery are unconfigured until credentials and destinations are supplied. Firestore composite indexes in `infrastructure/firestore/firestore.indexes.json` must be deployed before production-scale filtered queries.
