# Running the CQA portal with Docker

Containers: `db` (MySQL 8) and `app` (Node/Express plus the Python AI model server, which Node starts itself).

## Start

```bash
cp .env.example .env      # fill in every value; see the comments inside
docker compose up -d --build
docker compose logs -f app
```

Open `http://<server>:3000` (change with `APP_PORT`). The app creates all tables and its default data on first start, so `cqa_db.sql` and `admin-portal/migrations/` are **not** needed.

## Put it on the CSPC domain

1. Point the domain at the server and put the institution's reverse proxy/TLS in front of port `APP_PORT`. The proxy must send `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` (see `deploy/nginx-cqa.conf` for an example).
2. Keep `NODE_ENV=production`: session cookies are HTTPS-only, so the site must be served over HTTPS.
3. Set `GOOGLE_CALLBACK_URL` to `https://<domain>/auth/google/callback` and add the same URL, plus the domain as an authorized origin, in Google Cloud Console.
4. Make sure the reCAPTCHA keys allow the new domain.
5. Change the default admin and office passwords after the first login (see `docs/`).

## Data and backups

| Volume | Holds |
|---|---|
| `db_data` | MySQL data |
| `app_data` | landing-page content (`landing-data.json`) |
| `app_uploads` | uploaded logos and profile photos |

Back up the database:

```bash
docker compose exec db sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" cqa_db' > backup.sql
```

To move the existing production data, import a dump from the current database:

```bash
docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" cqa_db' < backup.sql
```

## Update / stop

```bash
git pull && docker compose up -d --build
docker compose down          # keeps data; add -v to DELETE all data
```

## Notes

- `.env` holds secrets and is gitignored. Never commit it; this repository is public.
- The old GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys over SSH to the previous VM with systemd. Disable or remove it once hosting moves, otherwise every push to `main` will still try to deploy there.
