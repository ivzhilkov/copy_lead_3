# amoCRM copy leads backend (Railway-ready)

NestJS backend for amoCRM widget "Copy deal".

## What is already configured

- `Dockerfile` in project root (Railway detects it automatically)
- `railway.json` with `DOCKERFILE` builder and healthcheck
- app listens on `PORT` (required by Railway)
- MySQL/Redis config supports both explicit vars and URL vars

## Required environment variables

Set these in Railway service variables:

- `CLIENT_ID`
- `CLIENT_SECRET`
- `WIDGET_CODE`
- `REDIRECT_URI` (example: `https://<your-domain>.up.railway.app/auth/callback`)

## Database variables (choose one of variants)

### Variant A (recommended in Railway plugins)

MySQL:
- `MYSQLHOST`
- `MYSQLPORT`
- `MYSQLUSER`
- `MYSQLPASSWORD`
- `MYSQLDATABASE`

Redis:
- `REDISHOST`
- `REDISPORT`
- `REDISPASSWORD` (optional)

### Variant B (URL form)

- `MYSQL_URL` or `DATABASE_URL`
- `REDIS_URL`

## Deploy in Railway

1. Connect this repository in Railway.
2. Add MySQL service.
3. Add Redis service.
4. Set variables from this README.
5. Deploy.

## Smoke test

Open `https://<your-domain>.up.railway.app/`.

Expected response:

`Status online`
