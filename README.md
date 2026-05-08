# The Playbook

iPhone-first PWA task manager. Built for daily execution with persistent push notification nudges that keep firing every 5 minutes until you act on them.

## Features

- **My Day view** — today's tasks, overdue tasks, and pinned tasks in one place
- **Smart Sort** — surfaces what matters most (overdue → today → high priority)
- **Persistent nudges** — server-side push that re-fires every 5 minutes until you tap Done or Snooze
- **Quiet Hours** — no nudges during your sleep window
- **Lists with colors** — color-code your task lists (urgent = red, follow up = blue, etc.)
- **Activity log** — timestamped updates per task, separated into User and System entries
- **Checklist** — sub-steps within a task
- **Repeat** — daily, weekly, monthly, weekdays, every Monday, custom every-X-days
- **Pin to My Day** — force a task into today's view regardless of due date
- **Calendar view** — monthly grid showing tasks per day
- **Backup / Restore** — JSON export and import
- **Light & Dark themes** — Apple-style aesthetic, blur and translucency throughout
- **Offline-ready** — service worker caches the app shell

## Getting Started

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

The first run auto-generates VAPID keys and prints them to the console. Copy them into a `.env` file so push notifications keep working between restarts.

## Deploying to Vercel

1. Push this repo to GitHub.
2. Import the repo in Vercel.
3. Add these env vars in **Project → Settings → Environment Variables**:
   - `VAPID_PUBLIC_KEY` — from the local console output
   - `VAPID_PRIVATE_KEY` — from the local console output
   - `VAPID_EMAIL` — `mailto:you@example.com`
   - `DB_PATH` — `/tmp/ops.db`
4. Redeploy.

## Installing on iPhone

Push notifications **only work when the PWA is installed to your Home Screen** (iOS 16.4+).

1. Open the Vercel URL in Safari on iPhone.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Open the app from the Home Screen icon (not from Safari).
4. Open **Settings → Push Notifications → Enable**.

## How the Nudge System Works

When a task has a due date and a time set, the server triggers reminders based on your settings:

- At fire time, you receive the first push notification with **Done** and **Snooze 5m** action buttons.
- If you don't act on it, the server re-fires every 5 minutes (configurable).
- After 6 nudges (configurable), the server stops to avoid being annoying.
- Tapping **Done** marks the task complete and clears the nudge cycle.
- Tapping **Snooze 5m** in the notification pauses for 5 minutes and resumes nudging.
- Opening the app and tapping the task clears the nudge cycle automatically.
- Quiet Hours (set in Settings) pause nudges during your sleep window.

## Tech

Single-file frontend (`public/index.html`), Express + SQLite + node-cron + web-push backend (`server.js`), and a service worker (`public/sw.js`) for the install + push pipeline.
