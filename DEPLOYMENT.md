# Deployment

Deploy the API container with a dedicated service account, Firebase Admin configuration through the host's secret manager, and a private Storage bucket. Deploy Firestore indexes and security rules from `infrastructure/firestore`. Build the employer web application with public Firebase client configuration only.

Scheduled report delivery requires these server-only environment variables:

- `RESEND_API_KEY`: the Resend API key.
- `EMAIL_FROM`: a verified Resend sender, for example `Workstream Reports <reports@yourdomain.com>`.
- `NOTIFICATION_ENCRYPTION_KEY`: a 32-byte base64 encryption key used for queued report bodies.
- `SCHEDULER_SECRET`: a random secret of at least 32 characters shared with the GitHub Actions scheduler.

The scheduler calls `POST /v1/jobs/run`. Report delivery is email-only through Resend. Daily and weekly employee reports can be enabled separately for employees and for the employer from the dashboard settings.
