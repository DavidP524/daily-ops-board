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

    // Write back to .env if the file exists
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

// Enable WAL mode for better concurrent read performance
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
    createdAt TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    position INTEGER DEFAULT 0
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

try {
  db.prepare('ALTER TABLE tasks ADD COLUMN reminderLeadMinutes TEXT DEFAULT \'\';').run();
} catch (_) {
  // Column already exists.
}

// Seed default lists if empty
const listCount = db.prepare('SELECT COUNT(*) as cnt FROM lists').get();
if (listCount.cnt === 0) {
  const defaultLists = ['General', 'Urgent', 'Follow Up', 'Waiting On', 'Backlog'];
  const insertList = db.prepare('INSERT INTO lists (name, position) VALUES (?, ?)');
  defaultLists.forEach((name, i) => insertList.run(name, i));
}

// Seed default settings if empty
const settingsCount = db.prepare('SELECT COUNT(*) as cnt FROM settings').get();
if (settingsCount.cnt === 0) {
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('morning_digest_enabled', 'false');
  insertSetting.run('morning_digest_time', '07:00');
  insertSetting.run('reminders_enabled', 'false');
  insertSetting.run('reminder_lead_minutes', '10');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
];
if (process.env.RENDER_EXTERNAL_URL) {
  allowedOrigins.push(process.env.RENDER_EXTERNAL_URL);
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g. same-origin, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseTask(row) {
  if (!row) return null;
  return {
    ...row,
    checklist: safeParseJSON(row.checklist, []),
    activityLog: safeParseJSON(row.activityLog, []),
  };
}

function safeParseJSON(str, fallback) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

function stringifyTask(body) {
  const out = { ...body };
  if (Array.isArray(out.checklist)) out.checklist = JSON.stringify(out.checklist);
  if (Array.isArray(out.activityLog)) out.activityLog = JSON.stringify(out.activityLog);
  return out;
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  return obj;
}

// ---------------------------------------------------------------------------
// Push helper
// ---------------------------------------------------------------------------
async function sendPush(title, body, icon, actions, data) {
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  const payload = JSON.stringify({ title, body, icon, badge: icon, actions: actions || [], data: data || {} });

  for (const sub of subs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(subscription, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
      } else {
        console.error('[Push] Delivery error:', err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Routes — Tasks
// ---------------------------------------------------------------------------
app.get('/api/tasks', (req, res) => {
  const rows = db.prepare('SELECT * FROM tasks').all();
  res.json(rows.map(parseTask));
});

app.get('/api/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Task not found' });
  res.json(parseTask(row));
});

app.post('/api/tasks', (req, res) => {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO tasks (id, title, nextAction, list, dueDate, reminderTime, reminderLeadMinutes, priority, status,
      notes, links, checklist, activityLog, pinnedToday, repeat, repeatEvery, createdAt, updatedAt)
    VALUES (@id, @title, @nextAction, @list, @dueDate, @reminderTime, @reminderLeadMinutes, @priority, @status,
      @notes, @links, @checklist, @activityLog, @pinnedToday, @repeat, @repeatEvery, @createdAt, @updatedAt)
  `).run(task);

  const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.status(201).json(parseTask(created));
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const raw = stringifyTask(req.body);
  const ALLOWED_TASK_FIELDS = [
    'title', 'nextAction', 'list', 'dueDate', 'reminderTime', 'reminderLeadMinutes', 'priority',
    'status', 'notes', 'links', 'checklist', 'activityLog', 'pinnedToday',
    'repeat', 'repeatEvery',
  ];
  const picked = {};
  for (const key of ALLOWED_TASK_FIELDS) {
    if (key in raw) picked[key] = raw[key];
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
      reminderTime = @reminderTime, reminderLeadMinutes = @reminderLeadMinutes, priority = @priority, status = @status, notes = @notes,
      links = @links, checklist = @checklist, activityLog = @activityLog,
      pinnedToday = @pinnedToday, repeat = @repeat, repeatEvery = @repeatEvery,
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
app.get('/api/lists', (req, res) => {
  const rows = db.prepare('SELECT * FROM lists ORDER BY position ASC').all();
  res.json(rows);
});

app.post('/api/lists', (req, res) => {
  const { name, position } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO lists (name, position) VALUES (?, ?)').run(name, position ?? 0);
  const created = db.prepare('SELECT * FROM lists WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(created);
});

app.put('/api/lists/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'List not found' });
  const name = req.body.name ?? existing.name;
  const position = req.body.position ?? existing.position;
  db.prepare('UPDATE lists SET name = ?, position = ? WHERE id = ?').run(name, position, req.params.id);
  const updated = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/lists/:id', (req, res) => {
  db.prepare('DELETE FROM lists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/lists/reorder', (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'names must be an array' });
  const update = db.prepare('UPDATE lists SET position = ? WHERE name = ?');
  db.exec('BEGIN');
  try {
    names.forEach((name, i) => update.run(i, name));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

app.post('/api/lists/replace', (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'names must be an array' });
  const clean = [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
  if (!clean.includes('General')) clean.unshift('General');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM lists').run();
    const insert = db.prepare('INSERT INTO lists (name, position) VALUES (?, ?)');
    clean.forEach((name, i) => insert.run(name, i));
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
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
  const ALLOWED_SETTINGS_KEYS = [
    'morning_digest_enabled',
    'morning_digest_time',
    'reminders_enabled',
    'reminder_lead_minutes',
  ];
  const filtered = Object.entries(req.body).filter(([key]) => ALLOWED_SETTINGS_KEYS.includes(key));
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.exec('BEGIN');
  try {
    for (const [key, value] of filtered) {
      upsert.run(key, String(value));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json(getSettings());
});

// ---------------------------------------------------------------------------
// Routes — Push
// ---------------------------------------------------------------------------
app.get('/api/push/vapid-public-key', (req, res) => {
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

// ---------------------------------------------------------------------------
// Cron — Reminder notifications (every minute)
// ---------------------------------------------------------------------------
cron.schedule('* * * * *', async () => {
  const settings = getSettings();
  if (settings.reminders_enabled !== 'true') return;

  const now = new Date();

  // Fetch open tasks with both reminderTime and dueDate set
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status != 'Completed'
      AND reminderTime != ''
      AND dueDate != ''
  `).all();

  for (const task of tasks) {
    const leadMinutes = parseInt(task.reminderLeadMinutes || settings.reminder_lead_minutes || '10', 10);
    const leadMs = leadMinutes * 60 * 1000;
    const targetEpoch = now.getTime() + leadMs;
    const taskEpoch = new Date(task.dueDate + 'T' + task.reminderTime + ':00').getTime();
    if (taskEpoch >= targetEpoch - 60000 && taskEpoch <= targetEpoch + 60000) {
      await sendPush(
        `Reminder: ${task.title}`,
        `Due at ${task.reminderTime} - ${task.nextAction || 'Tap to view'}`,
        '/icons/icon-192.png',
        [{ action: 'done', title: 'Mark Done' }],
        { taskId: task.id, url: '/' }
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Cron — Morning digest (every minute, fires once per day at configured time)
// ---------------------------------------------------------------------------
let lastDigestDate = '';

cron.schedule('* * * * *', async () => {
  const settings = getSettings();
  if (settings.morning_digest_enabled !== 'true') return;

  const digestTime = settings.morning_digest_time || '07:00';
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const currentHHMM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  if (currentHHMM !== digestTime) return;
  if (lastDigestDate === todayStr) return;

  lastDigestDate = todayStr;

  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'Open'
      AND dueDate != ''
      AND dueDate <= ?
  `).all(todayStr);

  if (tasks.length === 0) return;

  await sendPush(
    'Daily Ops — Your Day Ahead',
    `${tasks.length} task${tasks.length !== 1 ? 's' : ''} need attention today`,
    '/icons/icon-192.png',
    [],
    { url: '/' }
  );
});

// ---------------------------------------------------------------------------
// Start — local dev or Vercel serverless
// ---------------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => console.log(`Daily Ops server running on port ${PORT}`));
}

module.exports = app;
