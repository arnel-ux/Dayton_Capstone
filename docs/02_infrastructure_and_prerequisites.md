# Infrastructure Requirements & Software Prerequisites (Checklist Items #6, #7)

DRAFT from `admin-portal/package.json`, `ai_scripts/requirements.txt`, `deploy/*`, and `server.js`.

## Architecture (runtime)
```
Browser / PWA --HTTPS--> Nginx (:80/:443) --> Node/Express (admin-portal/server.js, :3000)
                                                   |-- spawns --> Python Flask AI server (ai_scripts/model_server.py, :8765, localhost only)
                                                   |                  '--> Gemini API (Google)
                                                   |-- MySQL (cqa_db)
                                                   |-- Google OAuth (client login)
                                                   |-- reCAPTCHA (admin login)
                                                   '-- SMTP mail server (password reset / notices)
```
**Important:** the Python AI server is NOT separate. Node starts it itself (`startModelServer()` spawns `python ai_scripts/model_server.py`). The server (or Docker image) therefore needs **both Node and Python**, even though no local ML model is used anymore.

## Server specification
| Item | Requirement |
|---|---|
| OS | Ubuntu 22.04/24.04 LTS (current deployment is Ubuntu). Any Linux that runs Node 20 and Python 3.10+. |
| CPU / RAM | 1 vCPU, 1 GB RAM minimum, 2 GB recommended. The systemd unit caps memory at 768 MB. |
| Storage | 5 GB for OS, app, and logs. Add space for uploads and DB backups. |
| Web server | Nginx reverse proxy (`deploy/nginx-cqa.conf`): 80/443 to 127.0.0.1:3000, `client_max_body_size 20M`. |
| DBMS | MySQL 8 / MariaDB 10.x with database `cqa_db`, utf8mb4. Currently external (Clever Cloud). |
| DB privileges | The app user needs SELECT/INSERT/UPDATE/DELETE **and CREATE/ALTER/INDEX**, because the app creates and alters its own tables on startup. |
| Process manager | systemd unit `cqa-admin-portal.service` (auto-restart), or a Docker container with `restart: unless-stopped`. |

## Network requirements
Inbound: TCP 80 and 443 (SSH 22 for admins only). Port 3000 and 8765 must NOT be public.

Outbound (must be allowed by the CSPC firewall):
| Destination | Purpose |
|---|---|
| `generativelanguage.googleapis.com:443` | Gemini comment analysis |
| `accounts.google.com`, `www.googleapis.com` :443 | Google OAuth sign-in |
| `www.google.com/recaptcha` :443 | reCAPTCHA verification |
| SMTP host :587 (or 465) | Password reset and notification emails |
| MySQL host :3306 | Database (if not on the same server) |

For the move to `cspc.edu.ph`:
- DNS A record for the chosen hostname, plus an SSL certificate (Let's Encrypt or CSPC's).
- Update **Google OAuth** authorized redirect URI to the new `GOOGLE_CALLBACK_URL`.
- Register the new domain in the **reCAPTCHA** key settings.
- HTTPS is required for the PWA/service worker and for secure cookies.

## Software prerequisites
| Component | Version | Source |
|---|---|---|
| Node.js | 20 LTS | `deploy/setup.sh` |
| npm packages | see below | `admin-portal/package.json` |
| Python | 3.10+ with venv | `deploy/setup.sh` |
| Python packages | `flask`, `google-genai`, `python-dotenv` | `ai_scripts/requirements.txt` |
| Nginx | distro package | apt |

npm dependencies: bcryptjs, cookie, cookie-signature, dotenv, ejs, express (4.x), express-session, multer, mysql2, nodemailer, on-headers, passport, passport-google-oauth20. All are open source (MIT/ISC/BSD/Apache licences). **Pin versions** by committing `package-lock.json` and installing with `npm ci`.

Third-party services (accounts and keys needed): Google Cloud OAuth client, Google AI Studio (Gemini) API key, reCAPTCHA keys, SMTP account.

## Environment variables (`deploy/.env.example`)
| Variable | Purpose |
|---|---|
| `PORT` | Node port (default 3000) |
| `NODE_ENV` | Set to `production` (enables secure cookies). Not in the example file yet. |
| `SESSION_SECRET` | Long random string for cookie signing. Required. |
| `TRUST_PROXY` | Proxy trust setting. Default `loopback`; set it when the proxy is not on the same host. |
| `DB_HOST/PORT/USER/PASSWORD/NAME` | MySQL connection |
| `DB_SSL`, `DB_CONNECTION_LIMIT` | TLS toggle and pool size (default 4) |
| `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_CALLBACK_URL` | Client Google login |
| `MAIL_HOST/PORT/SECURE/USER/PASS/FROM` | Outgoing email |
| `RECAPTCHA_SITE_KEY/SECRET_KEY` | Admin login captcha |
| `GEMINI_API_KEY` | Required by the AI server |
| `AI_MODEL_SERVER_PORT` | Internal AI server port (default 8765) |
| `DISPLAY_TIME_ZONE` | Optional display time zone |

## Current deployment (for reference)
Azure Ubuntu VM, provisioned with `deploy/setup.sh`, deployed by `.github/workflows/deploy.yml` (SSH, `git reset --hard`, `npm install`, `systemctl restart`), MySQL on Clever Cloud. Turnover to CSPC replaces the VM, the DB host, the domain, and the secrets. It does not change the code.

## Docker notes (only if MIS approves)
- One image needs Node 20 **and** Python 3 (`pip install -r ai_scripts/requirements.txt`). A `node:20-slim` base plus `python3 python3-pip` is the easiest route.
- Persist `public/images/uploads/` as a volume. Do not rely on files inside the container.
- Set `TRUST_PROXY` for the proxy container, `NODE_ENV=production`, and pass secrets through env or an env-file.
- Make sure `python` resolves, because `getPythonExecutable()` in `server.js` spawns it by name.
