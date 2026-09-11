# Employer accounts

The authentication screen supports signup, sign-in, and password reset. Signup asks for company name, owner name, email, and a password of at least eight characters. It creates the Firebase Authentication identity through the API and atomically writes the company, owner membership, company defaults, global normalized email reservation, and audit entry to Firestore. Success returns to sign-in without automatically signing the owner in.

Firebase Authentication rejects duplicate owner emails. The shared Firestore email reservation also rejects emails belonging to employees, including concurrent attempts to reserve the same email. If the Firestore transaction fails, the API attempts to remove only the identity created by that request. Failed compensation is logged for administrator reconciliation.

Password reset uses Firebase Authentication's sendPasswordResetEmail. Firestore does not store passwords or send reset emails. The form returns a neutral confirmation to avoid disclosing whether a reset email belongs to an account.

## Development configuration

Set VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN and VITE_FIREBASE_PROJECT_ID in apps/employer-web/.env. Enable Email/Password in Firebase Authentication and configure the password reset email template. Set FIREBASE_PROJECT_ID and application-default credentials (or FIREBASE_ADMIN_CONFIG) in the API process environment. Use the same Firebase project for both applications. The local Vite server proxies /v1 requests to port 8080 when VITE_API_URL is unset. Restart services after changing environment configuration.

No live signup or reset email can complete until Firebase is configured. The signup API tests use isolated Auth and Firestore test doubles to cover validation, success, duplicate email rejection, and failure compensation; they do not send emails or create real accounts.
