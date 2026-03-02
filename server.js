const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const FormData = require("form-data");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const os = require("os");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const Database = require("better-sqlite3");
require("dotenv").config();

// Use bundled ffmpeg for Railway/cloud hosting
let FFMPEG_PATH = "ffmpeg";
try {
  const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
  FFMPEG_PATH = ffmpegInstaller.path;
  console.log("FFmpeg bundled path:", FFMPEG_PATH);
} catch(e) {
  console.log("Using system ffmpeg");
}

const app = express();
const PORT = process.env.PORT || 1179;

// ============================================================
// DATABASE
// ============================================================
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "xello.sqlite"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    tier TEXT DEFAULT 'trial',
    uploads_this_month INTEGER DEFAULT 0,
    total_uploads INTEGER DEFAULT 0,
    month_reset TEXT DEFAULT '',
    roblox_user_id TEXT,
    roblox_api_key TEXT,
    roblox_group_id TEXT,
    roblox_group_api_key TEXT,
    creator_type TEXT DEFAULT 'user',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    tier TEXT NOT NULL,
    max_uses INTEGER DEFAULT 1,
    uses INTEGER DEFAULT 0,
    created_by TEXT DEFAULT 'admin',
    expires_at TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS upload_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT,
    asset_id TEXT,
    operation_id TEXT,
    status TEXT DEFAULT 'PENDING',
    error_msg TEXT,
    tempo_multiplier REAL DEFAULT 1,
    pitch_shift REAL DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// ============================================================
// TIER CONFIG
// ============================================================
const TIERS = {
  trial:    { label: "Trial",    limit: parseInt(process.env.TIER_TRIAL_LIMIT)    || 3,      color: "#ff9800" },
  beginner: { label: "Beginner", limit: parseInt(process.env.TIER_BEGINNER_LIMIT) || 50,     color: "#2196f3" },
  pro:      { label: "Pro",      limit: parseInt(process.env.TIER_PRO_LIMIT)      || 999999, color: "#00e5ff" }
};

// ============================================================
// HELPERS
// ============================================================
function log(msg, type = "info") {
  const prefix = { error: "❌", success: "✅", warn: "⚠️", info: "ℹ️" }[type] || "ℹ️";
  console.log(`[${new Date().toISOString()}] ${prefix} ${msg}`);
}

function checkResetMonthly(userId) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (user.month_reset !== currentMonth) {
    db.prepare("UPDATE users SET uploads_this_month = 0, month_reset = ? WHERE id = ?")
      .run(currentMonth, userId);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  }
  return user;
}

function userSafeData(user) {
  const tier = TIERS[user.tier] || TIERS.trial;
  const remaining = user.tier === "pro" ? "Unlimited" : Math.max(0, tier.limit - user.uploads_this_month);
  return {
    authenticated: true,
    id: user.id,
    username: user.username,
    email: user.email,
    tier: user.tier,
    tier_label: tier.label,
    tier_color: tier.color,
    tier_limit: tier.limit,
    uploads_this_month: user.uploads_this_month,
    total_uploads: user.total_uploads,
    remaining,
    roblox_user_id: user.roblox_user_id,
    roblox_group_id: user.roblox_group_id,
    creator_type: user.creator_type,
    has_api_key: !!(user.roblox_api_key || user.roblox_group_api_key),
    is_active: user.is_active,
    created_at: user.created_at
  };
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Bypass localtunnel password screen
app.use((req, res, next) => {
  res.setHeader("bypass-tunnel-reminder", "true");
  next();
});
app.use(session({
  secret: process.env.SESSION_SECRET || "xello_fallback_secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: "Login required" });
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(403).json({ error: "Admin only" });
}

// ============================================================
// AUTH ROUTES
// ============================================================

// Register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password, email, invite_code } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username dan password wajib diisi" });
    if (username.length < 3) return res.status(400).json({ error: "Username minimal 3 karakter" });
    if (password.length < 6) return res.status(400).json({ error: "Password minimal 6 karakter" });

    const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username.toLowerCase());
    if (exists) return res.status(400).json({ error: "Username sudah digunakan" });

    let assignedTier = "trial";

    // Check invite code
    if (invite_code && invite_code.trim()) {
      const code = db.prepare("SELECT * FROM invite_codes WHERE code = ? AND is_active = 1").get(invite_code.trim().toUpperCase());
      if (!code) return res.status(400).json({ error: "Kode invite tidak valid atau sudah tidak aktif" });
      if (code.max_uses > 0 && code.uses >= code.max_uses) return res.status(400).json({ error: "Kode invite sudah mencapai batas penggunaan" });
      if (code.expires_at && new Date(code.expires_at) < new Date()) return res.status(400).json({ error: "Kode invite sudah expired" });
      assignedTier = code.tier;
      db.prepare("UPDATE invite_codes SET uses = uses + 1 WHERE id = ?").run(code.id);
      if (code.max_uses > 0 && code.uses + 1 >= code.max_uses) {
        db.prepare("UPDATE invite_codes SET is_active = 0 WHERE id = ?").run(code.id);
      }
    }

    const hash = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const currentMonth = new Date().toISOString().slice(0, 7);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, email, tier, month_reset)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, username.toLowerCase(), hash, email || null, assignedTier, currentMonth);

    log(`New user registered: ${username} (tier: ${assignedTier})`);
    res.json({ success: true, message: `Akun berhasil dibuat! Tier kamu: ${TIERS[assignedTier].label}` });
  } catch (e) {
    log(e.message, "error");
    res.status(500).json({ error: "Server error" });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Isi username dan password" });

    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username.toLowerCase());
    if (!user) return res.status(401).json({ error: "Username atau password salah" });
    if (!user.is_active) return res.status(403).json({ error: "Akun kamu dinonaktifkan. Hubungi admin." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Username atau password salah" });

    checkResetMonthly(user.id);
    req.session.userId = user.id;
    log(`User login: ${username}`);
    res.json({ success: true, redirect: "/dashboard" });
  } catch (e) {
    log(e.message, "error");
    res.status(500).json({ error: "Server error" });
  }
});

// Admin login
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Kredensial admin salah" });
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Me - no requireAuth here, check manually
app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  try {
    const user = checkResetMonthly(req.session.userId);
    if (!user) { req.session.destroy(); return res.json({ authenticated: false }); }
    res.json({ authenticated: true, ...userSafeData(user) });
  } catch(e) {
    res.json({ authenticated: false });
  }
});

// ============================================================
// ROBLOX SETTINGS
// ============================================================
app.post("/api/settings/roblox", requireAuth, (req, res) => {
  const { creator_type, roblox_user_id, roblox_api_key, roblox_group_id, roblox_group_api_key } = req.body;
  if (!["user", "group"].includes(creator_type)) return res.status(400).json({ error: "creator_type tidak valid" });

  if (creator_type === "user") {
    if (!roblox_user_id) return res.status(400).json({ error: "Roblox User ID wajib diisi" });
    // Jika api_key kosong, pertahankan yang lama
    if (roblox_api_key && roblox_api_key.trim()) {
      db.prepare("UPDATE users SET creator_type='user', roblox_user_id=?, roblox_api_key=?, roblox_group_id=NULL, roblox_group_api_key=NULL WHERE id=?")
        .run(roblox_user_id, roblox_api_key.trim(), req.session.userId);
    } else {
      db.prepare("UPDATE users SET creator_type='user', roblox_user_id=?, roblox_group_id=NULL, roblox_group_api_key=NULL WHERE id=?")
        .run(roblox_user_id, req.session.userId);
    }
  } else {
    if (!roblox_group_id || !roblox_user_id) return res.status(400).json({ error: "Group ID dan User ID wajib diisi" });
    db.prepare("UPDATE users SET creator_type='group', roblox_user_id=?, roblox_group_id=?, roblox_group_api_key=?, roblox_api_key=NULL WHERE id=?")
      .run(roblox_user_id, roblox_group_id, roblox_group_api_key || null, req.session.userId);
  }
  res.json({ success: true, message: "Roblox account berhasil dihubungkan!" });
});

// ============================================================
// INVITE CODE ROUTES (user)
// ============================================================
app.post("/api/invite/redeem", requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Kode invite wajib diisi" });

  const invite = db.prepare("SELECT * FROM invite_codes WHERE code = ? AND is_active = 1").get(code.trim().toUpperCase());
  if (!invite) return res.status(400).json({ error: "Kode tidak valid atau sudah tidak aktif" });
  if (invite.max_uses > 0 && invite.uses >= invite.max_uses) return res.status(400).json({ error: "Kode sudah mencapai batas penggunaan" });
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: "Kode sudah expired" });

  db.prepare("UPDATE invite_codes SET uses = uses + 1 WHERE id = ?").run(invite.id);
  if (invite.max_uses > 0 && invite.uses + 1 >= invite.max_uses) {
    db.prepare("UPDATE invite_codes SET is_active = 0 WHERE id = ?").run(invite.id);
  }
  db.prepare("UPDATE users SET tier = ? WHERE id = ?").run(invite.tier, req.session.userId);

  log(`User ${req.session.userId} redeemed code ${code} → tier: ${invite.tier}`);
  res.json({ success: true, message: `Tier berhasil diupgrade ke ${TIERS[invite.tier].label}!`, tier: invite.tier });
});

// ============================================================
// ADMIN ROUTES
// ============================================================

// Get all users
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
  res.json(users.map(u => ({ ...userSafeData(u), email: u.email })));
});

// Update user tier
app.patch("/api/admin/users/:id/tier", requireAdmin, (req, res) => {
  const { tier } = req.body;
  if (!TIERS[tier]) return res.status(400).json({ error: "Tier tidak valid" });
  db.prepare("UPDATE users SET tier = ? WHERE id = ?").run(tier, req.params.id);
  res.json({ success: true });
});

// Toggle user active
app.patch("/api/admin/users/:id/toggle", requireAdmin, (req, res) => {
  const user = db.prepare("SELECT is_active FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
  db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(user.is_active ? 0 : 1, req.params.id);
  res.json({ success: true, is_active: !user.is_active });
});

// Delete user
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Get all invite codes
app.get("/api/admin/invites", requireAdmin, (req, res) => {
  const codes = db.prepare("SELECT * FROM invite_codes ORDER BY created_at DESC").all();
  res.json(codes);
});

// Create invite code
app.post("/api/admin/invites", requireAdmin, (req, res) => {
  const { tier, max_uses, expires_at, custom_code } = req.body;
  if (!TIERS[tier]) return res.status(400).json({ error: "Tier tidak valid" });

  const code = custom_code
    ? custom_code.trim().toUpperCase()
    : "XELLO-" + Math.random().toString(36).toUpperCase().slice(2, 8);

  const exists = db.prepare("SELECT id FROM invite_codes WHERE code = ?").get(code);
  if (exists) return res.status(400).json({ error: "Kode sudah ada" });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO invite_codes (id, code, tier, max_uses, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, code, tier, max_uses || 1, expires_at || null);

  res.json({ success: true, code });
});

// Delete invite code
app.delete("/api/admin/invites/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM invite_codes WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Admin stats
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const byTier = db.prepare("SELECT tier, COUNT(*) as c FROM users GROUP BY tier").all();
  const totalUploads = db.prepare("SELECT SUM(total_uploads) as c FROM users").get().c || 0;
  const recentUploads = db.prepare("SELECT * FROM upload_history ORDER BY created_at DESC LIMIT 20").all();
  res.json({ totalUsers, byTier, totalUploads, recentUploads });
});

// Upload history for admin
app.get("/api/admin/history", requireAdmin, (req, res) => {
  const history = db.prepare(`
    SELECT h.*, u.username FROM upload_history h
    LEFT JOIN users u ON h.user_id = u.id
    ORDER BY h.created_at DESC LIMIT 100
  `).all();
  res.json(history);
});

// ============================================================
// AUDIO PROCESSING
// ============================================================

// Helper: build atempo filter chain (atempo hanya menerima 0.5 - 2.0 per node)
function buildAtempoChain(tempo) {
  const filters = [];
  let t = tempo;
  // Handle tempo < 0.5 (chain ke bawah)
  while (t < 0.5) {
    filters.push("atempo=0.5");
    t /= 0.5;
  }
  // Handle tempo > 2.0 (chain ke atas)
  while (t > 2.0) {
    filters.push("atempo=2.0");
    t /= 2.0;
  }
  if (Math.abs(t - 1.0) > 0.0001) {
    filters.push(`atempo=${t.toFixed(6)}`);
  }
  return filters;
}

function processAudio(inputBuffer, filename, tempo = 1.0, pitch = 0) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const ts = Date.now();
    const inputPath = path.join(tmpDir, `rblx_in_${ts}.mp3`);
    const outputPath = path.join(tmpDir, `rblx_out_${ts}.mp3`);
    fs.writeFileSync(inputPath, inputBuffer);

    let filterParts = [];

    // 1. Pitch shift dulu (asetrate trick) — HARUS sebelum atempo
    if (pitch !== 0) {
      const sampleRate = 44100;
      const pitchFactor = Math.pow(2, pitch / 12);
      const newRate = Math.round(sampleRate * pitchFactor);
      filterParts.push(`asetrate=${newRate}`);
      filterParts.push(`aresample=${sampleRate}`);
      // Kompensasi perubahan durasi akibat asetrate
      // 1/pitchFactor bisa < 0.5, jadi pakai buildAtempoChain
      const tempoComp = 1 / pitchFactor;
      filterParts.push(...buildAtempoChain(tempoComp));
    }

    // 2. Tempo adjustment setelah pitch
    if (tempo !== 1.0) {
      filterParts.push(...buildAtempoChain(tempo));
    }

    const args = ["-i", inputPath];
    if (filterParts.length > 0) {
      args.push("-af", filterParts.join(","));
    }
    // Gunakan -b:a bukan -ab (deprecated)
    args.push("-ar", "44100", "-b:a", "192k", "-y", outputPath);

    log(`FFmpeg args: ${args.join(" ")}`);

    execFile(FFMPEG_PATH, args, { timeout: 120000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(inputPath); } catch {}
      if (err) {
        log(`FFmpeg error: ${err.message}`, "error");
        log(`FFmpeg stderr: ${stderr}`, "error");
        try { fs.unlinkSync(outputPath); } catch {}
        return reject(err);
      }
      try {
        const buf = fs.readFileSync(outputPath);
        fs.unlinkSync(outputPath);
        log(`Audio processed: ${(inputBuffer.length/1024).toFixed(0)}KB -> ${(buf.length/1024).toFixed(0)}KB`);
        resolve(buf);
      } catch (e) { reject(e); }
    });
  });
}

// ============================================================
// UPLOAD ROUTE
// ============================================================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.post("/api/upload", requireAuth, upload.array("files"), async (req, res) => {
  const user = checkResetMonthly(req.session.userId);
  if (!user.is_active) return res.status(403).json({ error: "Akun kamu dinonaktifkan." });

  const apiKey = user.creator_type === "group" ? user.roblox_group_api_key : user.roblox_api_key;
  if (!apiKey) return res.status(400).json({ error: "Belum ada API Key Roblox. Pergi ke Settings." });
  if (!req.files?.length) return res.status(400).json({ error: "Tidak ada file." });

  const tierInfo = TIERS[user.tier] || TIERS.trial;
  const remaining = tierInfo.limit - user.uploads_this_month;
  const filesToProcess = user.tier === "pro" ? req.files : req.files.slice(0, Math.max(0, remaining));

  if (filesToProcess.length === 0) {
    return res.status(429).json({ error: `Limit upload bulan ini habis (${tierInfo.limit}/${tierInfo.label}). Upgrade tier kamu!` });
  }

  const processTempo = req.body.processTempo === "true";
  const tempoMultiplier = parseFloat(req.body.tempoMultiplier) || 2.0;
  const pitchShift = parseFloat(req.body.pitchShift) || 0;
  const results = [];

  for (const file of filesToProcess) {
    log(`Upload: ${file.originalname} by ${user.username}`);
    let fileBuffer = file.buffer;
    const needsProcess = processTempo || pitchShift !== 0;

    if (needsProcess) {
      try {
        fileBuffer = await processAudio(file.buffer, file.originalname, processTempo ? tempoMultiplier : 1.0, pitchShift);
      } catch (e) {
        log(`FFmpeg error: ${e.message}`, "warn");
        // fallback original
      }
    }

    const histId = uuidv4();
    const histEntry = {
      id: histId, user_id: user.id, filename: file.originalname,
      file_size: file.size, status: "FAILED", asset_id: null,
      tempo_multiplier: processTempo ? tempoMultiplier : 1,
      pitch_shift: pitchShift, error_msg: null
    };

    let success = false;
    for (let attempt = 1; attempt <= 3 && !success; attempt++) {
      try {
        const displayName = path.basename(file.originalname, path.extname(file.originalname));
        const creatorField = user.creator_type === "group"
          ? { groupId: parseInt(user.roblox_group_id) }
          : { userId: parseInt(user.roblox_user_id) };

        const metadata = {
          assetType: "Audio", displayName,
          description: "Uploaded via XELLO Studio",
          creationContext: { creator: creatorField }
        };
        const form = new FormData();
        form.append("request", JSON.stringify(metadata));
        form.append("fileContent", fileBuffer, { filename: file.originalname, contentType: "audio/mpeg" });

        const response = await axios.post("https://apis.roblox.com/assets/v1/assets", form, {
          headers: { "x-api-key": apiKey, ...form.getHeaders() },
          maxBodyLength: Infinity, maxContentLength: Infinity
        });

        let { assetId, operationId } = response.data;
        if (operationId && !assetId) {
          const poll = await pollOperation(operationId, apiKey);
          if (poll.success) assetId = poll.assetId;
          else throw new Error(JSON.stringify(poll.error));
        }

        histEntry.status = "SUCCESS";
        histEntry.asset_id = assetId;
        histEntry.operation_id = operationId;
        db.prepare("UPDATE users SET uploads_this_month = uploads_this_month + 1, total_uploads = total_uploads + 1 WHERE id = ?")
          .run(user.id);
        success = true;
        log(`Success: ${file.originalname} → ${assetId}`, "success");
      } catch (e) {
        histEntry.error_msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        log(`Attempt ${attempt} failed: ${histEntry.error_msg}`, "error");
        if (e.response?.status === 429) await new Promise(r => setTimeout(r, 10000));
        else if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
      }
    }

    db.prepare(`
      INSERT INTO upload_history (id, user_id, filename, asset_id, operation_id, status, error_msg, tempo_multiplier, pitch_shift, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(histEntry.id, histEntry.user_id, histEntry.filename, histEntry.asset_id, histEntry.operation_id || null,
      histEntry.status, histEntry.error_msg, histEntry.tempo_multiplier, histEntry.pitch_shift, histEntry.file_size);

    results.push({ ...histEntry, file: file.originalname });
    await new Promise(r => setTimeout(r, 1000));
  }

  const sukses = results.filter(r => r.status === "SUCCESS").length;
  res.json({ total: filesToProcess.length, success: sukses, results });
});

// ============================================================
// HISTORY ROUTE
// ============================================================
app.get("/api/history", requireAuth, (req, res) => {
  const history = db.prepare(
    "SELECT * FROM upload_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
  ).all(req.session.userId);
  res.json(history);
});

app.delete("/api/history/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM upload_history WHERE id = ? AND user_id = ?").run(req.params.id, req.session.userId);
  res.json({ success: true });
});

// Health check

// Debug endpoint - cek roblox settings user
app.get("/api/debug/roblox", requireAuth, (req, res) => {
  const user = db.prepare("SELECT creator_type, roblox_user_id, roblox_group_id, roblox_api_key, roblox_group_api_key FROM users WHERE id=?").get(req.session.userId);
  res.json({
    creator_type: user.creator_type,
    roblox_user_id: user.roblox_user_id,
    roblox_group_id: user.roblox_group_id,
    has_api_key: !!(user.roblox_api_key),
    has_group_api_key: !!(user.roblox_group_api_key),
    api_key_preview: user.roblox_api_key ? user.roblox_api_key.slice(0,20)+"..." : null
  });
});

app.get("/ping", (req, res) => res.json({ status: "ok", time: new Date().toISOString(), port: PORT }));

// Page ROUTES
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ============================================================
// START
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  log(`🚀 XELLO SaaS running on port ${PORT}`);
  log(`Tiers: Trial=${TIERS.trial.limit} | Beginner=${TIERS.beginner.limit} | Pro=Unlimited`);
});
