'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const { DatabaseSync: Database } = require('node:sqlite');
const cron = require('node-cron');

// ---------------------------------------------------------------------------
// VAPID key bootstrap
// ---------------------------------------------------------------------------
(function ensureVapidKeys() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    console.log('[VAPID] Keys auto-generated. Copy these to your .env file:');
    console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
    console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);

    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/^VAPID_PUBLIC_KEY=.*$/m, '');
      envContent = envContent.replace(/^VAPID_PRIVATE_KEY=.*$/m, '');
      envContent = envContent.trimEnd();
      envContent += `\nVAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`;
      fs.writeFileSync(envPath, envContent, 'utf8');
    }
  }
})();

webpush.setVapidDetails(
  process.env.VAPID_EMAIL || 'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
const dbDir = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'ops.db'));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data', 'ops.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    nextAction TEXT DEFAULT '',
    list TEXT DEFAULT 'General',
    dueDate TEXT DEFAULT '',
    reminderTime TEXT DEFAULT '',
    reminderLeadMinutes TEXT DEFAULT '',
    priority TEXT DEFAULT 'Normal',
    status TEXT DEFAULT 'Open',
    notes TEXT DEFAULT '',
    links TEXT DEFAULT '',
    checklist TEXT DEFAULT '[]',
    activityLog TEXT DEFAULT '[]',
    pinnedToday INTEGER DEFAULT 0,
    repeat TEXT DEFAULT 'none',
    repeatEvery TEXT DEFAULT '',
    lastNudgedAt TEXT DEFAULT '',
    nudgeCount INTEGER DEFAULT 0,
    snoozeUntil TEXT DEFAULT '',
    createdAt TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    position INTEGER DEFAULT 0,
    color TEXT DEFAULT 'gray'
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Add new columns to tasks if they don't exist (idempotent migration)
const addCol = (col, def) => {
  try { db.prepare(`ALTER TABLE tasks ADD COLUMN ${col} ${def};`).run(); } catch (_) {}
};
addCol('reminderLeadMinutes', "TEXT DEFAULT ''");
addCol('lastNudgedAt', "TEXT DEFAULT ''");
addCol('nudgeCount', 'INTEGER DEFAULT 0');
addCol('snoozeUntil', "TEXT DEFAULT ''");

try { db.prepare("ALTER TABLE lists ADD COLUMN color TEXT DEFAULT 'gray';").run(); } catch (_) {}

// Seed default lists if empty
const listCount = db.prepare('SELECT COUNT(*) as cnt FROM lists').get();
if (listCount.cnt === 0) {
  const defaults = [
    ['General', 'gray'],
    ['Urgent', 'red'],
    ['Follow Up', 'blue'],
    ['Waiting On', 'orange'],
    ['Backlog', 'purple'],
  ];
  const insertList = db.prepare('INSERT INTO lists (name, position, color) VALUES (?, ?, ?)');
  defaults.forEach(([name, color], i) => insertList.run(name, i, color));
}

// Seed default settings if empty
const settingsCount = db.prepare('SELECT COUNT(*) as cnt FROM settings').get();
if (settingsCount.cnt === 0) {
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('reminders_enabled', 'true');
  insertSetting.run('reminder_lead_minutes', '0');
  insertSetting.run('nudge_interval_minutes', '5');
  insertSetting.run('max_nudges', '6');
  insertSetting.run('quiet_hours_enabled', 'false');
  insertSetting.run('quiet_hours_start', '22:00');
  insertSetting.run('quiet_hours_end', '07:00');
  insertSetting.run('user_name', '');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function parseTask(row) {
  if (!row) return null;
  return {
    ...row,
    checklist: safeParseJSON(row.checklist, []),
    activityLog: safeParseJSON(row.activityLog, []),
    pinnedToday: !!row.pinnedToday,
  };
}

function stringifyTask(body) {
  const out = { ...body };
  if (Array.isArray(out.checklist)) out.checklist = JSON.stringify(out.checklist);
  if (Array.isArray(out.activityLog)) out.activityLog = JSON.stringify(out.activityLog);
  if (typeof out.pinnedToday === 'boolean') out.pinnedToday = out.pinnedToday ? 1 : 0;
  return out;
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  return obj;
}

function isInQuietHours(settings, now = new Date()) {
  if (settings.quiet_hours_enabled !== 'true') return false;
  const [sh, sm] = (settings.quiet_hours_start || '22:00').split(':').map(Number);
  const [eh, em] = (settings.quiet_hours_end || '07:00').split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  // Wraps midnight
  return cur >= start || cur < end;
}

// ---------------------------------------------------------------------------
// Push helper
// ---------------------------------------------------------------------------
async function sendPush(payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (subs.length === 0) return 0;
  const json = JSON.stringify(payload);
  let sent = 0;

  for (const sub of subs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(subscription, json);
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
      } else {
        console.error('[Push] Delivery error:', err.message);
      }
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Routes — Tasks
// ---------------------------------------------------------------------------
app.get('/api/tasks', (_req, res) => {
  const rows = db.prepare('SELECT * FROM tasks').all();
  res.json(rows.map(parseTask));
});

app.get('/api/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Task not found' });
  res.json(parseTask(row));
});

app.post('/api/tasks', (req, res) => {
  const id = req.body.id || `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const body = stringifyTask(req.body);

  const task = {
    id,
    title: body.title || '',
    nextAction: body.nextAction || '',
    list: body.list || 'General',
    dueDate: body.dueDate || '',
    reminderTime: body.reminderTime || '',
    reminderLeadMinutes: body.reminderLeadMinutes || '',
    priority: body.priority || 'Normal',
    status: body.status || 'Open',
    notes: body.notes || '',
    links: body.links || '',
    checklist: body.checklist || '[]',
    activityLog: body.activityLog || '[]',
    pinnedToday: body.pinnedToday ? 1 : 0,
    repeat: body.repeat || 'none',
    repeatEvery: body.repeatEvery || '',
    lastNudgedAt: '',
    nudgeCount: 0,
    snoozeUntil: '',
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO tasks (id, title, nextAction, list, dueDate, reminderTime, reminderLeadMinutes, priority, status,
      notes, links, checklist, activityLog, pinnedToday, repeat, repeatEvery, lastNudgedAt, nudgeCount, snoozeUntil, createdAt, updatedAt)
    VALUES (@id, @title, @nextAction, @list, @dueDate, @reminderTime, @reminderLeadMinutes, @priority, @status,
      @notes, @links, @checklist, @activityLog, @pinnedToday, @repeat, @repeatEvery, @lastNudgedAt, @nudgeCount, @snoozeUntil, @createdAt, @updatedAt)
  `).run(task);

  const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.status(201).json(parseTask(created));
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const raw = stringifyTask(req.body);
  const ALLOWED_TASK_FIELDS = [
    'title', 'nextAction', 'list', 'dueDate', 'reminderTime', 'reminderLeadMinutes',
    'priority', 'status', 'notes', 'links', 'checklist', 'activityLog',
    'pinnedToday', 'repeat', 'repeatEvery', 'lastNudgedAt', 'nudgeCount', 'snoozeUntil',
  ];
  const picked = {};
  for (const key of ALLOWED_TASK_FIELDS) {
    if (key in raw) picked[key] = raw[key];
  }

  // If status flipped to Completed, clear nudge state automatically
  if (picked.status === 'Completed') {
    picked.lastNudgedAt = '';
    picked.nudgeCount = 0;
    picked.snoozeUntil = '';
  }

  // If the task is being rescheduled (dueDate or reminderTime changed), reset nudges
  if ('dueDate' in picked || 'reminderTime' in picked) {
    picked.lastNudgedAt = '';
    picked.nudgeCount = 0;
    picked.snoozeUntil = '';
  }

  const updated = {
    ...existing,
    ...picked,
    id: req.params.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(`
    UPDATE tasks SET
      title = @title, nextAction = @nextAction, list = @list, dueDate = @dueDate,
      reminderTime = @reminderTime, reminderLeadMinutes = @reminderLeadMinutes,
      priority = @priority, status = @status, notes = @notes,
      links = @links, checklist = @checklist, activityLog = @activityLog,
      pinnedToday = @pinnedToday, repeat = @repeat, repeatEvery = @repeatEvery,
      lastNudgedAt = @lastNudgedAt, nudgeCount = @nudgeCount, snoozeUntil = @snoozeUntil,
      createdAt = @createdAt, updatedAt = @updatedAt
    WHERE id = @id
  `).run(updated);

  const result = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  res.json(parseTask(result));
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routes — Lists
// ---------------------------------------------------------------------------
app.get('/api/lists', (_req, res) => {
  const rows = db.prepare('SELECT * FROM lists ORDER BY position ASC').all();
  res.json(rows);
});

app.post('/api/lists', (req, res) => {
  const { name, position, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO lists (name, position, color) VALUES (?, ?, ?)').run(name, position ?? 0, color || 'gray');
  const created = db.prepare('SELECT * FROM lists WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(created);
});

app.put('/api/lists/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'List not found' });
  const name = req.body.name ?? existing.name;
  const position = req.body.position ?? existing.position;
  const color = req.body.color ?? existing.color;
  db.prepare('UPDATE lists SET name = ?, position = ?, color = ? WHERE id = ?').run(name, position, color, req.params.id);
  const updated = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/lists/:id', (req, res) => {
  db.prepare('DELETE FROM lists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/lists/replace', (req, res) => {
  const { lists } = req.body;
  if (!Array.isArray(lists)) return res.status(400).json({ error: 'lists must be an array of {name, color}' });
  const clean = [];
  const seen = new Set();
  for (const item of lists) {
    const name = String((item && item.name) || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    clean.push({ name, color: (item && item.color) || 'gray' });
  }
  if (!clean.find(l => l.name === 'General')) clean.unshift({ name: 'General', color: 'gray' });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM lists').run();
    const insert = db.prepare('INSERT INTO lists (name, position, color) VALUES (?, ?, ?)');
    clean.forEach((l, i) => insert.run(l.name, i, l.color));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routes — Settings
// ---------------------------------------------------------------------------
app.get('/api/settings', (_req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
  const ALLOWED_SETTINGS_KEYS = [
    'reminders_enabled',
    'reminder_lead_minutes',
    'nudge_interval_minutes',
    'max_nudges',
    'quiet_hours_enabled',
    'quiet_hours_start',
    'quiet_hours_end',
    'user_name',
    'theme',
    'default_list',
    'default_priority',
  ];
  const filtered = Object.entries(req.body).filter(([key]) => ALLOWED_SETTINGS_KEYS.includes(key));
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.exec('BEGIN');
  try {
    for (const [key, value] of filtered) upsert.run(key, String(value));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json(getSettings());
});

// ---------------------------------------------------------------------------
// Routes — Push (subscribe / vapid / actions)
// ---------------------------------------------------------------------------
app.get('/api/push/vapid-public-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth)
    VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
  `).run(endpoint, keys.p256dh, keys.auth);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

// Test push — used by Settings "Send test" button
app.post('/api/push/test', async (_req, res) => {
  const sent = await sendPush({
    title: 'Playbook',
    body: 'Test notification — you\'re wired up!',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: '/' },
    actions: [],
  });
  res.json({ ok: true, sent });
});

// Acknowledge a nudge: action = 'done' | 'snooze5' | 'snooze15' | 'snooze60' | 'open'
app.post('/api/push/ack', (req, res) => {
  const { taskId, action } = req.body || {};
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.json({ ok: false, missing: true });

  const now = new Date();
  const isoNow = now.toISOString();

  if (action === 'done') {
    db.prepare(`
      UPDATE tasks SET status = 'Completed', updatedAt = ?, lastNudgedAt = '', nudgeCount = 0, snoozeUntil = ''
      WHERE id = ?
    `).run(isoNow, taskId);
    return res.json({ ok: true, action: 'done' });
  }

  let snoozeMs = 0;
  if (action === 'snooze5') snoozeMs = 5 * 60 * 1000;
  else if (action === 'snooze15') snoozeMs = 15 * 60 * 1000;
  else if (action === 'snooze60') snoozeMs = 60 * 60 * 1000;
  else if (action === 'open' || action === 'ack') snoozeMs = 0;

  if (snoozeMs > 0) {
    const until = new Date(now.getTime() + snoozeMs).toISOString();
    db.prepare(`
      UPDATE tasks SET snoozeUntil = ?, lastNudgedAt = '', nudgeCount = 0, updatedAt = ?
      WHERE id = ?
    `).run(until, isoNow, taskId);
    return res.json({ ok: true, action, snoozeUntil: until });
  }

  // Plain ack — just stop the nudge cycle (treat as user has seen it)
  db.prepare(`
    UPDATE tasks SET lastNudgedAt = '', nudgeCount = 0, updatedAt = ?
    WHERE id = ?
  `).run(isoNow, taskId);
  res.json({ ok: true, action: 'ack' });
});

// ---------------------------------------------------------------------------
// Cron — every minute: trigger reminders + re-fire nudges until acked
// ---------------------------------------------------------------------------
cron.schedule('* * * * *', async () => {
  try {
    const settings = getSettings();
    if (settings.reminders_enabled !== 'true') return;
    const now = new Date();
    if (isInQuietHours(settings, now)) return;

    const nudgeIntervalMs = (parseInt(settings.nudge_interval_minutes || '5', 10)) * 60 * 1000;
    const maxNudges = parseInt(settings.max_nudges || '6', 10);
    const defaultLead = parseInt(settings.reminder_lead_minutes || '0', 10);

    const tasks = db.prepare(`
      SELECT * FROM tasks
      WHERE status != 'Completed'
        AND reminderTime != ''
        AND dueDate != ''
    `).all();

    for (const task of tasks) {
      const lead = parseInt(task.reminderLeadMinutes || String(defaultLead), 10);
      const dueEpoch = new Date(task.dueDate + 'T' + task.reminderTime + ':00').getTime();
      const fireEpoch = dueEpoch - lead * 60 * 1000;

      // Skip if not due to fire yet
      if (now.getTime() < fireEpoch) continue;

      // Skip snoozed
      if (task.snoozeUntil) {
        const snoozeEpoch = new Date(task.snoozeUntil).getTime();
        if (now.getTime() < snoozeEpoch) continue;
      }

      // Determine if we should fire
      let shouldFire = false;
      let isFirstFire = false;
      const lastNudgedEpoch = task.lastNudgedAt ? new Date(task.lastNudgedAt).getTime() : 0;

      if (!lastNudgedEpoch) {
        shouldFire = true;
        isFirstFire = true;
      } else {
        if (task.nudgeCount >= maxNudges) continue;
        if (now.getTime() - lastNudgedEpoch >= nudgeIntervalMs - 1000) {
          shouldFire = true;
        }
      }

      // Don't fire if more than 6 hours past due (avoid surprises)
      if (now.getTime() - dueEpoch > 6 * 60 * 60 * 1000) continue;

      if (!shouldFire) continue;

      const titlePrefix = isFirstFire ? '' : `Reminder ${task.nudgeCount + 1}: `;
      const bodyParts = [];
      if (task.reminderTime) bodyParts.push(`Due at ${formatTime12(task.reminderTime)}`);
      if (task.nextAction) bodyParts.push(task.nextAction);
      const body = bodyParts.join(' — ') || 'Tap to view';

      await sendPush({
        title: `${titlePrefix}${task.title}`,
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: `task-${task.id}`,
        renotify: true,
        requireInteraction: true,
        actions: [
          { action: 'done', title: 'Done' },
          { action: 'snooze5', title: 'Snooze 5m' },
        ],
        data: { taskId: task.id, url: '/' },
      });

      db.prepare(`
        UPDATE tasks SET lastNudgedAt = ?, nudgeCount = nudgeCount + 1, snoozeUntil = ''
        WHERE id = ?
      `).run(now.toISOString(), task.id);
    }
  } catch (err) {
    console.error('[Cron] Error:', err.message);
  }
});

function formatTime12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = ((h + 11) % 12) + 1;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => console.log(`Playbook server running on http://localhost:${PORT}`));
}

module.exports = app;
