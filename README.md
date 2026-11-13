# NeuroGen AI Academy - Staff Attendance & Working Hours System

Node.js + Express + Postgres. Deploys free on Render (web app) + Neon (database).

## Deploy free (about 15 minutes)

### 1. Create the free database (Neon)
1. Sign up at https://neon.com and create a project (any name, choose a region near you, e.g. Singapore or Mumbai if offered).
2. On the project dashboard click **Connect** and copy the **connection string**. It starts with `postgresql://` and ends with `?sslmode=require`.
   Keep it secret - it is the password to your attendance data.

### 2. Put the code on GitHub
1. Sign up at https://github.com, click **New repository**, name it `attendance-system`, set it to **Private**.
2. Unzip this project. On the repository page choose **Add file > Upload files** and drag in ALL files and folders
   (`server.js`, `db.js`, `package.json`, `render.yaml`, `README.md`, `.gitignore`, the `public` folder). Do not upload `node_modules`. Click **Commit changes**.

### 3. Run it on Render
1. Sign up at https://render.com (use "Sign in with GitHub").
2. **New > Web Service**, pick your `attendance-system` repository.
3. Settings: Runtime **Node**, Build command `npm install`, Start command `npm start`, Instance type **Free**.
4. Add environment variables:
   - `DATABASE_URL` = the Neon connection string from step 1
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` = any long random text (30+ characters)
5. Click **Create Web Service**. When the log says `Attendance system running`, open your `https://....onrender.com` address.

### 4. First login
- Admin: `admin@neurogen.ai` / `Admin@123`
- Demo staff: `staff@neurogen.ai` / `Staff@123`
Change both passwords at once (Change password button). Then add real staff in Admin > Staff, and deactivate the demo staff account.

## Free-tier behaviour you should know
- Render's free web service goes to sleep after 15 minutes without visitors and takes about a minute to wake. The first person each morning
  may wait; tell staff to open the site and wait for the login page. A free uptime monitor (for example UptimeRobot) that opens
  `https://<your-site>/api/health` every 5 minutes keeps it awake. That address does not touch the database, so Neon can still sleep.
- Neon's free database sleeps after 5 minutes idle and wakes in a moment. If a request ever shows "The database is waking up", just retry.
- Free limits change over time. Check render.com and neon.com pricing pages. Your data lives in Neon, so a redeploy or restart on Render never erases it.
- Backups: in Neon you can export with `pg_dump` using the connection string, or use its built-in restore history. Do a monthly export of important data.

## Who can add or remove accounts
Only an admin can add staff, add another admin, deactivate or delete accounts (Admin > Staff). There is no sign-up page.

## What is included
- Admin and staff roles; staff only ever see their own data (enforced on the server).
- Check in / check out with IST timestamps set by the server.
- Tea, lunch and personal breaks, one at a time; check-out is blocked while a break is running.
- The database refuses two open sessions or two running breaks for one person.
- Net hours = office time minus unpaid breaks. Admin sets paid/unpaid and the maximum minutes for each break; alerts appear for staff and admin.
- Missed check-in / check-out / wrong-time requests with admin approval and an audit log.
- Admin board: working, on break, not logged in, forgot to log out, late; staff management; attendance history with edits; policies.

## Run on your own computer instead
Install Node.js 18+, set the environment variable `DATABASE_URL` to a Postgres connection string (a free Neon database works from your PC too), then `npm install` and `npm start`, and open http://localhost:3000.

## Coming next
Leave management, monthly/yearly reports and Excel export (waiting for the rest of the specification).
