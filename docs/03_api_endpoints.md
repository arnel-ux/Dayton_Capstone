# API / Route Reference (Checklist Item #5: API Documentation)

DRAFT generated from the route definitions in `admin-portal/server.js`. The app is server-rendered (EJS) plus JSON endpoints used by the pages and the offline PWA. Add request/response examples before final turnover.

Auth levels: **Public**, **Client** (`ensureClientAuth`), **Office** (`ensureOfficeAuth`), **Admin** (`ensureAdminAuth`), **Super Admin** (`ensureSuperAdmin`).

## Public / authentication
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | Public | Landing page |
| GET | `/api/public-dashboard` | Public | Public summary data for the landing page |
| GET | `/api/health` | Public | Health check, returns `{status:"ok"}` (use for Docker/monitoring) |
| GET | `/login` | Public | Admin login page |
| POST | `/auth-login` | Public (rate-limited, reCAPTCHA) | Admin login |
| GET/POST | `/office-login` | Public (rate-limited) | Office login |
| GET | `/office-logout`, `/logout` | Session | Logout |
| GET | `/client-login` | Public | Client login page |
| GET | `/auth/google`, `/auth/google/callback` | Public | Google OAuth for clients |
| GET/POST | `/complete-google-registration` | Public | Finish client registration |
| GET/POST | `/forgot-password`, `/reset-password` | Public | Password reset by email |

## Client (survey respondents)
| Method | Path | Purpose |
|---|---|---|
| GET | `/client-survey` | Survey page |
| POST | `/submit-survey` | Submit a survey response (AI analysis runs here) |
| POST | `/sync-surveys` | Sync surveys filled in offline |
| GET | `/survey-offline` | Offline survey page |
| POST | `/api/offline-surveys/verify-and-sync` | Verify identity and sync an offline submission (rate-limited, public) |
| GET/POST | `/api/client-profile` | Read/update profile |
| POST | `/api/client-password` | Change password (rate-limited) |
| POST | `/api/onboarding-complete` | Mark onboarding done |
| GET | `/api/client-history`, `/api/client-history/:id` | Past submissions |
| GET | `/api/client/offline-context` | Data needed to work offline |
| GET/PATCH/DELETE | `/api/client/notifications`, `/…/:id`, `/…/read-all`, `/…/:id/read` | Notification inbox |

## Office users
| Method | Path | Purpose |
|---|---|---|
| GET | `/office-dashboard` | Office dashboard |
| GET | `/office-report`, POST `/api/office-report-data`, POST `/api/office-analytics` | Office reports and analytics |
| GET | `/office-approvals`, `/office-approvals/history`, `/office-approvals/status`, `/office-approvals/notifications` | Pending approvals and status |
| POST | `/office-approvals/:id/approve`, `/office-approvals/:id/decline` | Approve or decline a submission |

## Admin
| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard`, `/report/dashboard`, `/report`, `/print` | Dashboards and printable reports |
| POST | `/api/report-data`, `/api/report-data-by-cluster` | Report data (JSON) |
| GET | `/survey-records` | Survey records list |
| GET | `/api/admin/survey-response/:id` | One response in detail |
| PATCH | `/api/admin/survey-response/:id/analysis` | Override AI topic/sentiment |
| GET | `/user-accounts` | Client accounts |
| GET / POST | `/api/admin/notifications`, `/api/admin/notifications/seen` | Admin notifications |
| GET/POST | `/profile`, `/password`, `/api/profile/photo` | Own profile, password, photo upload |
| GET | `/offices`, `/cluster/:id` | Offices and clusters |
| POST | `/clusters/add`, `/clusters/edit`, `/clusters/delete/:id`, `/clusters/restore/:id`, `/clusters/permanent-delete/:id` | Cluster management |
| POST | `/offices/add`, `/offices/edit`, `/offices/delete/:id`, `/offices/restore/:id`, `/offices/permanent-delete/:id` | Office management |
| POST | `/services/add`, `/services/edit`, `/services/delete/:id` | Service management |
| GET | `/survey` | Survey settings |
| POST | `/settings/add`, `/settings/edit`, `/settings/delete`, `/settings/restore`, `/period-covered/add` | Survey questions and period |

## Super Admin only
| Method | Path | Purpose |
|---|---|---|
| GET | `/manage-admins` | Admin accounts page |
| POST | `/admins/add`, `/admins/edit`, `/admins/delete/:id` | Create, edit, delete admins |

## Internal AI server (localhost only, not public)
| Method | Path | Purpose |
|---|---|---|
| GET | `http://127.0.0.1:8765/health` | `{status, ready}` |
| POST | `http://127.0.0.1:8765/analyze` | Body `{comment, office}`, returns `{sentiment, topics}` (Gemini) |

Note: routes listed from a grep of `app.get/post/patch/delete`. There may be a few more helper routes (for example around lines 4200–4250 and 5800–5830) that I did not enumerate. Re-check against `server.js` before publishing.
