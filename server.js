// ============================================================
// EduGuardian Backend Server
// Node.js + Express + SQLite
// Run: npm install && node server.js
// ============================================================

const express    = require('express');
const Database   = require('better-sqlite3');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const db   = new Database(path.join(__dirname, 'eduguardian.db'));

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'dashboard')));

// Simple API key auth
const VALID_API_KEY = process.env.API_KEY || 'EDU_GUARDIAN_API_KEY_CHANGE_ME';

function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (key !== VALID_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ── Database setup ─────────────────────────────────────────
db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id   TEXT UNIQUE NOT NULL,
        label       TEXT,
        school      TEXT,
        student_name TEXT,
        registered_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS violations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id     TEXT    NOT NULL,
        sim_serial    TEXT,
        sim_operator  TEXT,
        inserted_at   INTEGER NOT NULL,
        removed_at    INTEGER,
        duration_mins REAL,
        device_model  TEXT,
        android_ver   TEXT,
        received_at   INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS app_activities (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        violation_id  INTEGER NOT NULL,
        app_name      TEXT,
        package_name  TEXT,
        time_used_mins REAL,
        data_used_mb  REAL,
        FOREIGN KEY(violation_id) REFERENCES violations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_violations_device  ON violations(device_id);
    CREATE INDEX IF NOT EXISTS idx_violations_time    ON violations(inserted_at);
`);

// ── Routes ─────────────────────────────────────────────────

/**
 * POST /api/violations
 * Receives a SIM violation report from a tablet
 */
app.post('/api/violations', requireApiKey, (req, res) => {
    const {
        device_id, sim_serial, sim_operator,
        inserted_at, removed_at, duration_mins,
        activities, device_model, android_ver
    } = req.body;

    if (!device_id || !inserted_at) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Auto-register device if new
    db.prepare(`
        INSERT OR IGNORE INTO devices (device_id, label)
        VALUES (?, ?)
    `).run(device_id, `Tablet ${device_id.substring(0, 6).toUpperCase()}`);

    // Insert violation
    const result = db.prepare(`
        INSERT INTO violations
            (device_id, sim_serial, sim_operator, inserted_at, removed_at,
             duration_mins, device_model, android_ver)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(device_id, sim_serial, sim_operator, inserted_at, removed_at,
           duration_mins, device_model, android_ver);

    const violationId = result.lastInsertRowid;

    // Insert activities
    if (Array.isArray(activities)) {
        const insertActivity = db.prepare(`
            INSERT INTO app_activities
                (violation_id, app_name, package_name, time_used_mins, data_used_mb)
            VALUES (?, ?, ?, ?, ?)
        `);
        activities.forEach(a => {
            insertActivity.run(
                violationId, a.app_name, a.package_name,
                a.time_used_mins, a.data_used_mb
            );
        });
    }

    console.log(`📵 Violation recorded: device=${device_id}, sim=${sim_serial}`);
    res.json({ success: true, violation_id: violationId });
});

/**
 * GET /api/dashboard/summary
 * Summary stats for the admin dashboard
 */
app.get('/api/dashboard/summary', (req, res) => {
    const totalDevices    = db.prepare('SELECT COUNT(*) as c FROM devices').get().c;
    const totalViolations = db.prepare('SELECT COUNT(*) as c FROM violations').get().c;
    const today           = new Date(); today.setHours(0,0,0,0);
    const todayMs         = today.getTime();

    const todayViolations = db.prepare(
        'SELECT COUNT(*) as c FROM violations WHERE inserted_at >= ?'
    ).get(todayMs).c;

    const recentViolations = db.prepare(`
        SELECT v.*, d.label as device_label, d.student_name
        FROM violations v
        LEFT JOIN devices d ON d.device_id = v.device_id
        ORDER BY v.inserted_at DESC LIMIT 10
    `).all();

    const topOffenders = db.prepare(`
        SELECT v.device_id, d.label, d.student_name, COUNT(*) as count
        FROM violations v
        LEFT JOIN devices d ON d.device_id = v.device_id
        GROUP BY v.device_id
        ORDER BY count DESC LIMIT 5
    `).all();

    const topApps = db.prepare(`
        SELECT app_name, SUM(time_used_mins) as total_mins, COUNT(*) as sessions
        FROM app_activities
        GROUP BY app_name
        ORDER BY total_mins DESC LIMIT 10
    `).all();

    // Daily violations for chart (last 14 days)
    const dailyStats = db.prepare(`
        SELECT
            date(inserted_at/1000, 'unixepoch') as day,
            COUNT(*) as count
        FROM violations
        WHERE inserted_at >= ?
        GROUP BY day
        ORDER BY day
    `).all(Date.now() - 14 * 24 * 60 * 60 * 1000);

    res.json({
        totalDevices, totalViolations, todayViolations,
        recentViolations, topOffenders, topApps, dailyStats
    });
});

/**
 * GET /api/violations
 * Paginated list of all violations
 */
app.get('/api/violations', (req, res) => {
    const page    = parseInt(req.query.page  || '1');
    const limit   = parseInt(req.query.limit || '20');
    const offset  = (page - 1) * limit;
    const device  = req.query.device;

    let query = `
        SELECT v.*, d.label as device_label, d.student_name
        FROM violations v
        LEFT JOIN devices d ON d.device_id = v.device_id
    `;
    const params = [];
    if (device) { query += ' WHERE v.device_id = ?'; params.push(device); }
    query += ' ORDER BY v.inserted_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const violations = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as c FROM violations').get().c;

    res.json({ violations, total, page, limit });
});

/**
 * GET /api/violations/:id/activities
 * Activities for a specific violation
 */
app.get('/api/violations/:id/activities', (req, res) => {
    const activities = db.prepare(
        'SELECT * FROM app_activities WHERE violation_id = ? ORDER BY time_used_mins DESC'
    ).all(req.params.id);
    res.json({ activities });
});

/**
 * GET /api/devices
 * List all registered devices
 */
app.get('/api/devices', (req, res) => {
    const devices = db.prepare(`
        SELECT d.*,
               COUNT(v.id) as violation_count,
               MAX(v.inserted_at) as last_violation
        FROM devices d
        LEFT JOIN violations v ON v.device_id = d.device_id
        GROUP BY d.id
        ORDER BY violation_count DESC
    `).all();
    res.json({ devices });
});

/**
 * PUT /api/devices/:deviceId
 * Update device label / student name
 */
app.put('/api/devices/:deviceId', (req, res) => {
    const { label, student_name, school } = req.body;
    db.prepare(`
        UPDATE devices SET label=?, student_name=?, school=?
        WHERE device_id=?
    `).run(label, student_name, school, req.params.deviceId);
    res.json({ success: true });
});

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║  EduGuardian Server running on :${PORT}   ║
║  Dashboard: http://localhost:${PORT}      ║
╚════════════════════════════════════════╝
    `);
});
