# Production checklist

This backend is prepared to run as a public amoCRM widget backend on Railway.

## Railway services

- App service: one replica for now.
- MySQL service: stores accounts, billing state, OAuth data, and copy request statuses.
- Redis service: stores the Bull queue for copy jobs.

## Required environment variables

Keep the current Railway variables for amoCRM OAuth, MySQL, Redis, Telegram, and admin access.

Recommended for production:

```env
TOKEN_ENCRYPTION_KEY=<stable-random-secret>
```

If `TOKEN_ENCRYPTION_KEY` is not set, OAuth data encryption falls back to `CLIENT_SECRET`. Do not rotate the encryption key without a planned migration for existing OAuth rows.

## Database

TypeORM `synchronize` is disabled. Schema changes are applied through migrations on app startup.

Before connecting many clients:

- Enable Railway MySQL backups.
- Keep at least one recent backup before every major deployment.
- Do not delete the MySQL volume/service when redeploying the app.

## Queue and rate limiting

Copy jobs are processed through Redis/Bull instead of in-memory timers, so jobs survive normal HTTP request lifecycle and concurrent widget calls.

Current safety settings:

- Bull queue concurrency: `1`.
- Bull queue limiter: `1` copy job per `300 ms`.
- amoCRM API limiter inside the worker: global and per-account pacing.

Keep one app replica unless a distributed amoCRM API limiter is added. Multiple replicas would each have their own in-memory API limiter.

## Operational notes

- `/` is used as the Railway health check.
- `/billing/admin/panel` is the lightweight admin panel.
- Admin API requests require the `x-admin-token` header.
- Failed copy jobs send Telegram notifications when Telegram variables are configured.
