# Production deployment

Required production environment:

```env
NODE_ENV=production
PORT=3000
DB_HOST=...
DB_PORT=3306
DB_USERNAME=...
DB_PASSWORD=...
DB_DATABASE=...
DB_SYNCHRONIZE=false
DB_BOOTSTRAP_SCHEMA=false
DB_SSL=true
JWT_SECRET=<at least 32 random characters>
CORS_ORIGINS=https://pos.example.com,https://admin.example.com
```

For a brand-new empty database only, set `DB_BOOTSTRAP_SCHEMA=true` for the
first successful boot, then immediately change it to `false` and redeploy.
Never leave schema synchronization enabled for routine production deploys.
Apply reviewed migrations before starting later server versions.
`JWT_SECRET` is mandatory and startup fails without it. `CORS_ORIGINS`
is a comma-separated allowlist shared by HTTP and Socket.IO.

Recommended rollout:

1. Back up MySQL.
2. Run pending TypeORM migrations with `NODE_ENV=production` and
   `DB_SYNCHRONIZE=false`.
3. Start the API and verify `GET /health` returns only `{ status, timestamp }`.
4. Verify authentication, Socket.IO, one test payment, and its receipt.

Terminate TLS at the reverse proxy, keep MySQL private, rotate JWT secrets using
a planned session-expiration window, and collect application logs without request
passwords, challenges, authorization headers, or payment notes.
