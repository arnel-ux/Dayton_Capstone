# Security Review: CQA Admin Portal (Checklist Item #8)

DRAFT based on a read-only scan of `admin-portal/server.js` and `deploy/`. It is not a full penetration test. Items marked **verify** were not confirmed in code.

## What is already in place
| Area | Finding |
|---|---|
| Authentication | Separate admin, office, and client logins. Passwords are stored as bcrypt hashes (cost 10). |
| Session cookies | Signed, `httpOnly`, `sameSite=lax`, `secure` when `NODE_ENV=production`. 8-hour lifetime. |
| Session fixation | Admin and office sessions are regenerated at login. |
| Single session per admin | A new admin login invalidates the older session. |
| Roles | `ensureAdminAuth`, `ensureOfficeAuth`, `ensureClientAuth`, `ensureSuperAdmin` guards on routes. Manage-admins is Super Admin only. |
| Bot and brute-force protection | reCAPTCHA is verified server-side on admin login. Rate limiters on `/auth-login`, `/office-login`, offline sync/verify, and client password change. |
| Timing attacks | A dummy bcrypt compare runs for unknown accounts on offline verify. |
| Uploads | Profile photo upload accepts png/jpeg/webp only, max 5 MB. |
| Secrets | Read from environment variables (`.env` is git-ignored). `deploy/.env.example` holds placeholders only. |
| SQL | Spot check found parameterized queries (`?` placeholders). No obvious string-built SQL. This was not a full audit. |

## Gaps and recommended fixes (priority order)

### HIGH
1. **Default admin passwords are hardcoded in source.**
   `server.js` (~line 2415) seeds `admin1 / francis123` (Super Admin) and `admin2 / arnel123` when the `admins` table is empty. Anyone with the source code knows them.
   *Fix:* read the seed password from an env variable, or generate a random one and print it once. At minimum, document "change both passwords on first login" in the Admin Manual and the turnover checklist.
2. **`SESSION_SECRET` is not validated at startup.**
   If it is empty, cookie signing behaves badly (and can throw).
   *Fix:* `if (!process.env.SESSION_SECRET) { console.error(...); process.exit(1); }`
3. **No security headers.** There is no `helmet`, CSP, `X-Frame-Options`, `X-Content-Type-Options`, or HSTS.
   *Fix:* add `helmet` (or set the headers in Nginx). HSTS should only be enabled once HTTPS works.
4. **No CSRF tokens.** The app relies on `sameSite=lax` only. State-changing admin routes are POST forms.
   *Fix:* add a CSRF token to forms, or set `sameSite=strict` on admin and office cookies if the flows allow it.

### MEDIUM
5. **In-memory sessions.** The client uses `MemoryStore` and the admin/office use an in-process `Map`. All users are logged out on every restart or redeploy, and it cannot scale past one process.
   Acceptable for a single container. Document it. Optional upgrade: a DB-backed or Redis session store.
6. **DB TLS verification is off.** `ssl: { rejectUnauthorized: false }` when `DB_SSL=true`.
   If CSPC's MySQL is on the internal network, use `DB_SSL=false`. Otherwise supply the CA certificate and enable verification.
7. **Missing rate limits on some public endpoints** (**verify**): `/forgot-password`, `/reset-password`, `/complete-google-registration`. Email-sending endpoints can be abused for spam.
8. **Password policy is inconsistent.** A minimum length of 8 is enforced on client registration and reset. Admin and office password create/edit paths (`/admins/add`, `/admins/edit`, `/password`, `/offices/add`) were not seen enforcing it (**verify**). There is no complexity rule or lockout besides the rate limiter.
9. **`trust proxy` defaults to `loopback`.** This is correct for Nginx on the same host. In Docker, Nginx is on another container's IP, so `req.ip` and secure cookies break.
   *Fix:* set `TRUST_PROXY` (for example `TRUST_PROXY=1` or the proxy subnet) in the container environment.
10. **`NODE_ENV=production` must be set** or cookies are not marked `secure`. `deploy/.env.example` does not list it. Add it.

### LOW / HOUSEKEEPING
11. `ai_scripts/err.log`, `ai_scripts/out.log`, and uploaded images under `public/images/uploads/` are committed to git. Remove them from the repo and add them to `.gitignore`. User uploads need a persistent volume in production.
12. Server binds to `0.0.0.0`. This is fine behind a firewall or inside Docker, but a bare VM should expose only 80/443 through Nginx.
13. The root `package.json` (express ^5, ejs ^6) conflicts with `admin-portal/package.json` (express ^4, ejs ^3). Delete the root one or make it a note so MIS isn't confused about which to install.
14. The CI deploy uses `npm install`. Prefer `npm ci` for reproducible installs.
15. `cqa_db.sql` (Aug 31) is stale compared to the schema the app builds at startup. Regenerate it before turnover (see 04_database.md).
16. Comment text is sent to the Gemini API (Google). Disclose this in the Data Privacy statement and confirm with CSPC's DPO that it is acceptable.

## Backup and recovery (required by checklist #8; not yet documented)
- **Database:** nightly `mysqldump cqa_db | gzip > cqa_db_$(date +%F).sql.gz`, kept 14+ days, copy kept off-server. Restore with `gunzip < file.sql.gz | mysql cqa_db`.
- **Files:** back up `public/images/uploads/` and the `.env` (stored securely, not in git).
- **Recovery test:** restore onto a spare database once and record the result as evidence.
