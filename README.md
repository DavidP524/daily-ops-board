# Daily Ops Board

iOS-optimized PWA task manager with push notifications, morning digest, and cloud sync.

---

## Deploy to Vercel (Step-by-Step)

### Step 1 — Push your code to GitHub

1. Go to [github.com](https://github.com) and sign in (or create a free account).
2. Click **New repository**, name it `daily-ops-board`, and click **Create repository**.
3. On your computer, open a terminal in this folder and run:
   ```
   git add .
   git commit -m "Initial build"
   git remote add origin https://github.com/YOUR_USERNAME/daily-ops-board.git
   git push -u origin main
   ```

### Step 2 — Connect to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with your GitHub account.
2. Click **Add New → Project**.
3. Find `daily-ops-board` in the list and click **Import**.
4. Leave all settings at their defaults (Vercel auto-detects the `vercel.json`).
5. Click **Deploy** and wait ~60 seconds.

### Step 3 — Set Environment Variables in Vercel

After the first deploy, you need to add your VAPID keys (for push notifications):

1. In the Vercel dashboard, go to your project → **Settings → Environment Variables**.
2. Add these variables one at a time:

| Name | Value |
|------|-------|
| `VAPID_PUBLIC_KEY` | *(see below)* |
| `VAPID_PRIVATE_KEY` | *(see below)* |
| `VAPID_EMAIL` | `mailto:your@email.com` |
| `DB_PATH` | `/tmp/ops.db` |
| `NODE_ENV` | `production` |

**To get your VAPID keys:** Run the server locally once (`npm run dev`) and look at the terminal output — it will print `VAPID_PUBLIC_KEY=...`. Copy both keys from there into Vercel.

3. After adding all variables, go to **Deployments** and click **Redeploy** on the latest deployment.

### Step 4 — Add to iPhone Home Screen

Push notifications on iOS **only work when the app is added to your Home Screen**. Regular Safari tab = no push.

1. Open your Vercel app URL in Safari on your iPhone.
2. Tap the **Share** button (box with arrow pointing up).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add** in the top right.
5. The app now opens full-screen like a native app.

### Step 5 — Enable Push Notifications

1. Open the app from your Home Screen icon.
2. Tap **Settings** (gear icon) in the bottom nav.
3. Tap **Enable Push Notifications**.
4. When iOS asks for permission, tap **Allow**.
5. You should see "Push Notifications Active" in the Settings panel.
6. Toggle on **Morning Digest** and/or **Task Reminders** and set your times.

---

## Important Notes

### Data Persistence on Vercel
Vercel uses serverless functions. The SQLite database is stored at `/tmp/ops.db` which **resets between cold starts** (usually every few hours of inactivity). Your data is also saved to `localStorage` in your browser, so the app will always have local data — but server-synced data may reset.

**For permanent data persistence**, deploy to [Render.com](https://render.com) instead (free tier) using the persistent disk config below.

### Using Render.com Instead (Recommended for Permanent Storage)

1. Sign up at [render.com](https://render.com).
2. Click **New → Web Service** and connect your GitHub repo.
3. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Add the same environment variables as Vercel.
5. Under **Advanced**, add a **Disk** mount:
   - Mount Path: `/data`
   - Size: 1 GB
6. Set `DB_PATH` to `/data/ops.db` instead of `/tmp/ops.db`.

---

## Running Locally

```bash
npm install
cp .env.example .env
# Edit .env and fill in your values, or leave VAPID keys blank (auto-generated on first run)
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## Project Structure

```
├── server.js          # Express backend
├── public/
│   ├── index.html     # PWA frontend
│   ├── sw.js          # Service worker
│   ├── manifest.json  # PWA manifest
│   └── icons/         # App icons
├── package.json
├── vercel.json        # Vercel deployment config
└── .env.example       # Environment variable template
```
