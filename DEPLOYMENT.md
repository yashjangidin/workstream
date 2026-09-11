# Deployment

Deploy the API container to Cloud Run with a dedicated service account, Firebase Admin configuration through Secret Manager, and a private Storage bucket. Deploy Firestore indexes and security rules from `infrastructure/firestore`. Build the employer web application with public Firebase client configuration only. Configure scheduled report and offline-evaluation jobs with authenticated Cloud Scheduler calls using idempotency keys.
