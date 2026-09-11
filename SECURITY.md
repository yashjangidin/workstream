# Security

Workstream applies least privilege: backend authorization derives organization membership from verified Firebase identities; setup codes are random credentials stored only as hashes; device tokens are revocable; and every destructive administrative action writes an audit event.

Monitoring is opt-in at the employee configuration level and visibly disclosed in the agent. Screenshot and activity collection are hard-gated by an active timer plus Active Monitoring mode. Cloud Storage paths are scoped to a company and access is mediated by the API. Secrets belong in Secret Manager or local environment injection, never source files or browser bundles.
