const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const FormData = require("form-data");
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const youtubeDl = require("youtube-dl-exec");
const os = require("os");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const Database = require("better-sqlite3");
require("dotenv").config();

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

const TIERS = {
  trial:    { label: "Trial",    limit: parseInt(process.env.TIER_TRIAL_LIMIT)    || 3,      color: "#ff9800" },
  beginner: { label: "Beginner", limit: parseInt(process.env.TIER_BEGINNER_LIMIT) || 50,     color: "#2196f3" },
  pro:      { label: "Pro",      limit: parseInt(process.env.TIER_PRO_LIMIT)      || 999999, color: "#00e5ff" }
};

function log(msg, type = "info") {
  const prefix = { error: "❌", success: "✅", warn: "⚠️", info: "ℹ️" }[type] || "ℹ️";
  console.log(`[${new Date().toISOString()}] ${prefix} ${msg}`);
}

function checkResetMonthly(userId) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (user.month_reset !== currentMonth) {
    db.prepare("UPDATE users SET uploads_this_month = 0, month_reset = ? WHERE id = ?").run(currentMonth, userId);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  }
  return user;
}

function userSafeData(user) {
  const tier = TIERS[user.tier] || TIERS.trial;
  const remaining = user.tier === "pro" ? "Unlimited" : Math.max(0, tier.limit - user.uploads_this_month);
  return {
    authenticated: true, id: user.id, username: user.username, email: user.email,
    tier: user.tier, tier_label: tier.label, tier_color: tier.color, tier_limit: tier.limit,
    uploads_this_month: user.uploads_this_month, total_uploads: user.total_uploads, remaining,
    roblox_user_id: user.roblox_user_id, roblox_group_id: user.roblox_group_id,
    creator_type: user.creator_type, has_api_key: !!(user.roblox_api_key || user.roblox_group_api_key),
    is_active: user.is_active, created_at: user.created_at
  };
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { res.setHeader("bypass-tunnel-reminder", "true"); next(); });
app.use(session({
  secret: process.env.SESSION_SECRET || "xello_fallback_secret",
  resave: false, saveUninitialized: false,
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

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password, email, invite_code } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username dan password wajib diisi" });
    if (username.length < 3) return res.status(400).json({ error: "Username minimal 3 karakter" });
    if (password.length < 6) return res.status(400).json({ error: "Password minimal 6 karakter" });
    // ── INVITE CODE WAJIB ──────────────────────────────────────
    if (!invite_code || !invite_code.trim()) {
      return res.status(400).json({ error: "Kode invite wajib diisi. Hubungi admin untuk mendapatkan kode." });
    }
    const code = db.prepare("SELECT * FROM invite_codes WHERE code = ? AND is_active = 1").get(invite_code.trim().toUpperCase());
    if (!code) return res.status(400).json({ error: "Kode invite tidak valid atau sudah tidak aktif" });
    if (code.max_uses > 0 && code.uses >= code.max_uses) return res.status(400).json({ error: "Kode invite sudah mencapai batas penggunaan" });
    if (code.expires_at && new Date(code.expires_at) < new Date()) return res.status(400).json({ error: "Kode invite sudah expired" });
    // ────────────────────────────────────────────────────────────
    const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username.toLowerCase());
    if (exists) return res.status(400).json({ error: "Username sudah digunakan" });
    const assignedTier = code.tier;
    db.prepare("UPDATE invite_codes SET uses = uses + 1 WHERE id = ?").run(code.id);
    if (code.max_uses > 0 && code.uses + 1 >= code.max_uses) {
      db.prepare("UPDATE invite_codes SET is_active = 0 WHERE id = ?").run(code.id);
    }
    const hash = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const currentMonth = new Date().toISOString().slice(0, 7);
    db.prepare(`INSERT INTO users (id, username, password_hash, email, tier, month_reset) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userId, username.toLowerCase(), hash, email || null, assignedTier, currentMonth);
    log(`New user registered: ${username} (tier: ${assignedTier})`);
    res.json({ success: true, message: `Akun berhasil dibuat! Tier kamu: ${TIERS[assignedTier].label}` });
  } catch (e) { log(e.message, "error"); res.status(500).json({ error: "Server error" }); }
});

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
  } catch (e) { log(e.message, "error"); res.status(500).json({ error: "Server error" }); }
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Kredensial admin salah" });
});

app.post("/api/auth/logout", (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  try {
    const user = checkResetMonthly(req.session.userId);
    if (!user) { req.session.destroy(); return res.json({ authenticated: false }); }
    res.json({ authenticated: true, ...userSafeData(user) });
  } catch(e) { res.json({ authenticated: false }); }
});

app.post("/api/settings/roblox", requireAuth, (req, res) => {
  const { creator_type, roblox_user_id, roblox_api_key, roblox_group_id, roblox_group_api_key } = req.body;
  if (!["user", "group"].includes(creator_type)) return res.status(400).json({ error: "creator_type tidak valid" });
  if (creator_type === "user") {
    if (!roblox_user_id) return res.status(400).json({ error: "Roblox User ID wajib diisi" });
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

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
  res.json(users.map(u => ({ ...userSafeData(u), email: u.email })));
});
app.patch("/api/admin/users/:id/tier", requireAdmin, (req, res) => {
  const { tier } = req.body;
  if (!TIERS[tier]) return res.status(400).json({ error: "Tier tidak valid" });
  db.prepare("UPDATE users SET tier = ? WHERE id = ?").run(tier, req.params.id);
  res.json({ success: true });
});
app.patch("/api/admin/users/:id/toggle", requireAdmin, (req, res) => {
  const user = db.prepare("SELECT is_active FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
  db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(user.is_active ? 0 : 1, req.params.id);
  res.json({ success: true, is_active: !user.is_active });
});
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});
app.get("/api/admin/invites", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM invite_codes ORDER BY created_at DESC").all());
});
app.post("/api/admin/invites", requireAdmin, (req, res) => {
  const { tier, max_uses, expires_at, custom_code } = req.body;
  if (!TIERS[tier]) return res.status(400).json({ error: "Tier tidak valid" });
  const code = custom_code ? custom_code.trim().toUpperCase() : "XELLO-" + Math.random().toString(36).toUpperCase().slice(2, 8);
  if (db.prepare("SELECT id FROM invite_codes WHERE code = ?").get(code)) return res.status(400).json({ error: "Kode sudah ada" });
  const id = uuidv4();
  db.prepare(`INSERT INTO invite_codes (id, code, tier, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, code, tier, max_uses || 1, expires_at || null);
  res.json({ success: true, code });
});
app.delete("/api/admin/invites/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM invite_codes WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const byTier = db.prepare("SELECT tier, COUNT(*) as c FROM users GROUP BY tier").all();
  const totalUploads = db.prepare("SELECT SUM(total_uploads) as c FROM users").get().c || 0;
  const recentUploads = db.prepare("SELECT * FROM upload_history ORDER BY created_at DESC LIMIT 20").all();
  res.json({ totalUsers, byTier, totalUploads, recentUploads });
});
app.get("/api/admin/history", requireAdmin, (req, res) => {
  const history = db.prepare(`
    SELECT h.*, u.username FROM upload_history h
    LEFT JOIN users u ON h.user_id = u.id
    ORDER BY h.created_at DESC LIMIT 100
  `).all();
  res.json(history);
});

// Admin Roblox settings (simpan di env runtime / memory session)
app.get("/api/admin/roblox-settings", requireAdmin, (req, res) => {
  res.json({
    creator_type: req.session.adminCreatorType || process.env.ADMIN_CREATOR_TYPE || "user",
    roblox_user_id: req.session.adminUserId || process.env.ADMIN_ROBLOX_USER_ID || "",
    roblox_group_id: req.session.adminGroupId || process.env.ADMIN_ROBLOX_GROUP_ID || "",
    has_api_key: !!(req.session.adminApiKey || process.env.ADMIN_ROBLOX_API_KEY)
  });
});

app.post("/api/admin/roblox-settings", requireAdmin, (req, res) => {
  const { creator_type, roblox_user_id, roblox_api_key, roblox_group_id, roblox_group_api_key } = req.body;
  req.session.adminCreatorType = creator_type || "user";
  req.session.adminUserId = roblox_user_id || "";
  req.session.adminGroupId = roblox_group_id || "";
  if (roblox_api_key && roblox_api_key.trim()) req.session.adminApiKey = roblox_api_key.trim();
  if (roblox_group_api_key && roblox_group_api_key.trim()) req.session.adminGroupApiKey = roblox_group_api_key.trim();
  res.json({ success: true, message: "Roblox settings admin tersimpan!" });
});

// Admin upload route
const adminUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.post("/api/admin/upload", requireAdmin, adminUpload.array("files"), async (req, res) => {
  const creatorType = req.session.adminCreatorType || process.env.ADMIN_CREATOR_TYPE || "user";
  const apiKey = creatorType === "group"
    ? (req.session.adminGroupApiKey || process.env.ADMIN_ROBLOX_GROUP_API_KEY)
    : (req.session.adminApiKey || process.env.ADMIN_ROBLOX_API_KEY);
  const userId = req.session.adminUserId || process.env.ADMIN_ROBLOX_USER_ID;
  const groupId = req.session.adminGroupId || process.env.ADMIN_ROBLOX_GROUP_ID;

  if (!apiKey) return res.status(400).json({ error: "Belum ada API Key Roblox admin. Atur di Settings Upload." });
  if (!req.files?.length) return res.status(400).json({ error: "Tidak ada file." });

  // read titles if any
  let allTitles = [];
  if (req.body['titles[]']) {
    allTitles = Array.isArray(req.body['titles[]']) ? req.body['titles[]'] : [req.body['titles[]']];
  } else if (req.body.titles) {
    allTitles = Array.isArray(req.body.titles) ? req.body.titles : [req.body.titles];
  }

  const processTempo = req.body.processTempo === "true";
  const tempoMultiplier = parseFloat(req.body.tempoMultiplier) || 2.0;
  const pitchShift = parseFloat(req.body.pitchShift) || 0;
  const results = [];

  for (let idx = 0; idx < req.files.length; idx++) {
    const file = req.files[idx];
    const forcedTitle = allTitles[idx];
    log(`Admin upload: ${file.originalname}`);
    let fileBuffer = file.buffer;
    const needsProcess = processTempo || pitchShift !== 0;
    if (needsProcess) {
      try {
        fileBuffer = await processAudio(file.buffer, file.originalname, processTempo ? tempoMultiplier : 1.0, pitchShift);
      } catch (e) { log(`FFmpeg error: ${e.message}`, "warn"); }
    }

    const histEntry = { filename: file.originalname, status: "FAILED", asset_id: null, error_msg: null };
    let success = false;
    for (let attempt = 1; attempt <= 3 && !success; attempt++) {
      try {
        const forced = forcedTitle && forcedTitle.trim();
        const displayName = forced || path.basename(file.originalname, path.extname(file.originalname));
        const creatorField = creatorType === "group"
          ? { groupId: parseInt(groupId) }
          : { userId: parseInt(userId) };
        const metadata = {
          assetType: "Audio", displayName,
          description: "Uploaded via XELLO Studio (Admin)",
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

        // PATCH to update displayName after asset is created
        if (assetId && forced) {
          try {
            await axios.patch(
              `https://apis.roblox.com/assets/v1/assets/${assetId}?updateMask=displayName`,
              { displayName: forced },
              { headers: { "x-api-key": apiKey, "Content-Type": "application/json" } }
            );
            log(`Admin PATCH displayName: ${assetId} → "${forced}"`, "success");
          } catch (pe) {
            log(`Admin PATCH displayName failed (non-fatal): ${pe.message}`, "warn");
          }
        }

        histEntry.status = "SUCCESS";
        histEntry.asset_id = assetId;
        success = true;
        log(`Admin upload success: ${file.originalname} → ${assetId}`, "success");
      } catch (e) {
        histEntry.error_msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        log(`Admin upload attempt ${attempt} failed: ${histEntry.error_msg}`, "error");
        if (e.response?.status === 429) await new Promise(r => setTimeout(r, 10000));
        else if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
      }
    }
    results.push({ ...histEntry, file: file.originalname });
    await new Promise(r => setTimeout(r, 1000));
  }

  const sukses = results.filter(r => r.status === "SUCCESS").length;
  res.json({ total: req.files.length, success: sukses, results });
});

// ============================================================
// AUDIO PROCESSING - FIXED
// ============================================================

// Membangun atempo chain yang aman (0.5 - 2.0 per node)
function buildAtempoChain(tempo) {
  const filters = [];
  let t = tempo;
  while (t < 0.5) {
    filters.push("atempo=0.5");
    t /= 0.5;
  }
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

    // 1. Pitch dulu (asetrate trick)
    if (pitch !== 0) {
      const sampleRate = 44100;
      const pitchFactor = Math.pow(2, pitch / 12);
      const newRate = Math.round(sampleRate * pitchFactor);
      filterParts.push(`asetrate=${newRate}`);
      filterParts.push(`aresample=${sampleRate}`);
      // Kompensasi durasi — gunakan chain agar tidak < 0.5
      filterParts.push(...buildAtempoChain(1 / pitchFactor));
    }

    // 2. Tempo setelah pitch
    if (tempo !== 1.0) {
      filterParts.push(...buildAtempoChain(tempo));
    }

    const args = ["-i", inputPath];
    if (filterParts.length > 0) {
      args.push("-af", filterParts.join(","));
    }
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
// AUDIO EDITOR PROCESSING (trim + fade)
// ============================================================
function processAudioEditor(inputBuffer, filename, trimStart=0, trimEnd=0, fadeIn=0, fadeOut=0) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const ts = Date.now() + Math.random().toString(36).slice(2,7);
    const inputPath = path.join(tmpDir, `ed_in_${ts}.mp3`);
    const outputPath = path.join(tmpDir, `ed_out_${ts}.mp3`);
    fs.writeFileSync(inputPath, inputBuffer);

    const filterParts = [];

    // Trim using atrim filter for sample-accurate cut
    if (trimStart > 0 || trimEnd > 0) {
      let trimFilter = 'atrim=';
      if (trimStart > 0) trimFilter += `start=${trimStart.toFixed(3)}`;
      if (trimEnd > 0) trimFilter += (trimStart > 0 ? ':' : '') + `end=${trimEnd.toFixed(3)}`;
      filterParts.push(trimFilter);
      filterParts.push('asetpts=PTS-STARTPTS');
    }

    // Fade in
    if (fadeIn > 0) {
      filterParts.push(`afade=t=in:ss=0:d=${fadeIn.toFixed(3)}`);
    }

    // Fade out (relative to trimmed audio)
    if (fadeOut > 0) {
      const segDur = (trimEnd > 0 ? trimEnd : 9999) - (trimStart || 0);
      const st = Math.max(0, segDur - fadeOut);
      filterParts.push(`afade=t=out:st=${st.toFixed(3)}:d=${fadeOut.toFixed(3)}`);
    }

    const args = ["-i", inputPath];
    if (filterParts.length > 0) args.push("-af", filterParts.join(","));
    args.push("-ar", "44100", "-b:a", "192k", "-y", outputPath);

    log(`Editor FFmpeg args: ${args.join(" ")}`);

    execFile(FFMPEG_PATH, args, { timeout: 120000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(inputPath); } catch {}
      if (err) {
        log(`Editor FFmpeg error: ${stderr}`, "error");
        try { fs.unlinkSync(outputPath); } catch {}
        return reject(new Error("Gagal memproses audio"));
      }
      try {
        const buf = fs.readFileSync(outputPath);
        fs.unlinkSync(outputPath);
        resolve(buf);
      } catch (e) { reject(e); }
    });
  });
}

// ============================================================
// EDITOR ROUTES
// ============================================================
const uploadEditor = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post("/api/editor/process", requireAuth, uploadEditor.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const trimStart = parseFloat(req.body.trimStart) || 0;
  const trimEnd   = parseFloat(req.body.trimEnd)   || 0;
  const fadeIn    = parseFloat(req.body.fadeIn)    || 0;
  const fadeOut   = parseFloat(req.body.fadeOut)   || 0;
  try {
    const buf = await processAudioEditor(req.file.buffer, req.file.originalname, trimStart, trimEnd, fadeIn, fadeOut);
    const outName = req.file.originalname.replace(/\.mp3$/i, "_edited.mp3");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("X-Filename", outName);
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/fetch-audio", requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL wajib diisi" });

  // Validate URL pattern for YT and SoundCloud
  const isYT = /youtube\.com|youtu\.be/i.test(url);
  const isSC = /soundcloud\.com/i.test(url);
  if (!isYT && !isSC) return res.status(400).json({ error: "Hanya YouTube dan SoundCloud yang didukung" });

  const tmpDir = os.tmpdir();
  const uid = uuidv4();
  const outTemplate = path.join(tmpDir, `xdl_${uid}.%(ext)s`);

  log(`Fetching audio from: ${url}`);

  try {
    // Get title first
    let title = "audio";
    try {
      const info = await youtubeDl(url, { getTitle: true, noPlaylist: true, dumpSingleJson: false });
      if (typeof info === "string") title = info.replace(/[^\w\s\-]/g, "").trim().slice(0, 60) || "audio";
    } catch {}

    // Download as mp3 using youtube-dl-exec
    await youtubeDl(url, {
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: 5,
      noPlaylist: true,
      maxFilesize: "50m",
      output: outTemplate,
    });

    // Find output file
    const mp3Path = outTemplate.replace("%(ext)s", "mp3");
    if (!fs.existsSync(mp3Path)) {
      // Search for any downloaded file with our uid
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(`xdl_${uid}`));
      if (!files.length) throw new Error("File tidak ditemukan setelah download");
      const fullPath = path.join(tmpDir, files[0]);
      // Convert to mp3 if not already
      if (!files[0].endsWith(".mp3")) {
        const mp3Out = path.join(tmpDir, `xdl_${uid}_conv.mp3`);
        await new Promise((resolve, reject) => {
          execFile(FFMPEG_PATH, ["-i", fullPath, "-b:a", "192k", "-y", mp3Out], { timeout: 120000 }, (err) => {
            try { fs.unlinkSync(fullPath); } catch {}
            if (err) reject(err); else resolve();
          });
        });
        const buf = fs.readFileSync(mp3Out);
        fs.unlinkSync(mp3Out);
        const fname = `${title}.mp3`;
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
        res.setHeader("X-Filename", fname);
        return res.send(buf);
      }
    }

    const buf = fs.readFileSync(mp3Path);
    try { fs.unlinkSync(mp3Path); } catch {}
    const fname = `${title}.mp3`;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.setHeader("X-Filename", fname);
    res.send(buf);

  } catch(e) {
    log("fetch-audio error: " + e.message, "error");
    // Cleanup
    try {
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(`xdl_${uid}`));
      files.forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} });
    } catch {}
    res.status(500).json({ error: "Gagal mengambil audio. Pastikan URL valid dan coba lagi. (" + e.message.slice(0,100) + ")" });
  }
});

async function pollOperation(operationId, apiKey, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await axios.get(`https://apis.roblox.com/assets/v1/operations/${operationId}`, {
        headers: { "x-api-key": apiKey }
      });
      if (res.data.done) {
        if (res.data.error) return { success: false, error: res.data.error };
        return { success: true, assetId: res.data.response?.assetId };
      }
    } catch (e) { log(`Poll ${i+1} error: ${e.message}`, "warn"); }
  }
  return { success: false, error: "Timeout polling" };
}

// ============================================================
// UPLOAD ROUTE — SSE Streaming (anti-timeout Railway)
// ============================================================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.post("/api/upload", requireAuth, upload.array("files"), async (req, res) => {
  const user = checkResetMonthly(req.session.userId);

  // --- Validasi awal (sebelum SSE dimulai) ---
  if (!user.is_active)
    return res.status(403).json({ error: "Akun kamu dinonaktifkan." });
  const apiKey = user.creator_type === "group" ? user.roblox_group_api_key : user.roblox_api_key;
  if (!apiKey)
    return res.status(400).json({ error: "Belum ada API Key Roblox. Pergi ke Settings." });
  if (!req.files?.length)
    return res.status(400).json({ error: "Tidak ada file." });

  const tierInfo = TIERS[user.tier] || TIERS.trial;
  const remaining = tierInfo.limit - user.uploads_this_month;
  const filesToProcess = user.tier === "pro" ? req.files : req.files.slice(0, Math.max(0, remaining));

  if (filesToProcess.length === 0)
    return res.status(429).json({ error: `Limit upload bulan ini habis (${tierInfo.limit}/${tierInfo.label}). Upgrade tier kamu!` });

  // --- Mulai SSE — koneksi tetap hidup selama proses ---
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nonaktifkan buffering nginx/railway
  res.flushHeaders();

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  // Heartbeat tiap 8 detik supaya Railway/proxy tidak memutus koneksi
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch {}
  }, 8000);

  // Parse body
  let allTitles = [];
  if (req.body['titles[]']) {
    allTitles = Array.isArray(req.body['titles[]']) ? req.body['titles[]'] : [req.body['titles[]']];
  } else if (req.body.titles) {
    allTitles = Array.isArray(req.body.titles) ? req.body.titles : [req.body.titles];
  }
  const titlesToUse = allTitles.slice(0, filesToProcess.length);
  const processTempo = req.body.processTempo === "true";
  const tempoMultiplier = parseFloat(req.body.tempoMultiplier) || 1.0;
  const pitchShift = parseFloat(req.body.pitchShift) || 0;

  const results = [];
  let successCount = 0;

  for (let idx = 0; idx < filesToProcess.length; idx++) {
    const file = filesToProcess[idx];
    const forcedTitle = titlesToUse[idx];
    log(`Upload: ${file.originalname} by ${user.username}`);

    // Beritahu client: file ini sedang diproses
    send({ type: "progress", index: idx, file: file.originalname, status: "processing", message: `[${idx+1}/${filesToProcess.length}] Memproses audio: ${file.originalname}` });

    let fileBuffer = file.buffer;
    const needsProcess = processTempo || pitchShift !== 0;

    if (needsProcess) {
      send({ type: "progress", index: idx, file: file.originalname, status: "processing", message: `[${idx+1}/${filesToProcess.length}] FFmpeg: mengubah tempo/pitch...` });
      try {
        fileBuffer = await processAudio(file.buffer, file.originalname, processTempo ? tempoMultiplier : 1.0, pitchShift);
        send({ type: "progress", index: idx, file: file.originalname, status: "processing", message: `[${idx+1}/${filesToProcess.length}] Audio selesai diproses, mengupload...` });
      } catch (e) {
        log(`FFmpeg error: ${e.message}`, "warn");
        send({ type: "progress", index: idx, file: file.originalname, status: "processing", message: `[${idx+1}/${filesToProcess.length}] FFmpeg gagal, upload file original...` });
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
      if (attempt > 1) {
        send({ type: "progress", index: idx, file: file.originalname, status: "processing", message: `[${idx+1}/${filesToProcess.length}] Retry ke-${attempt}...` });
      }
      try {
        const forced = forcedTitle && forcedTitle.trim();
        const displayName = forced || path.basename(file.originalname, path.extname(file.originalname));
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
          send({ type: "progress", index: idx, file: file.originalname, status: "processing", message: `[${idx+1}/${filesToProcess.length}] Menunggu Roblox memproses aset...` });
          const poll = await pollOperation(operationId, apiKey);
          if (poll.success) assetId = poll.assetId;
          else throw new Error(JSON.stringify(poll.error));
        }

        // PATCH displayName setelah asset dibuat
        if (assetId && forced) {
          try {
            await axios.patch(
              `https://apis.roblox.com/assets/v1/assets/${assetId}?updateMask=displayName`,
              { displayName: forced },
              { headers: { "x-api-key": apiKey, "Content-Type": "application/json" } }
            );
            log(`DisplayName patched: ${assetId} → "${forced}"`, "success");
          } catch (pe) {
            log(`PATCH displayName failed (non-fatal): ${pe.message}`, "warn");
          }
        }

        histEntry.status = "SUCCESS";
        histEntry.asset_id = assetId;
        histEntry.operation_id = operationId;
        db.prepare("UPDATE users SET uploads_this_month = uploads_this_month + 1, total_uploads = total_uploads + 1 WHERE id = ?")
          .run(user.id);
        success = true;
        successCount++;
        log(`Success: ${file.originalname} → ${assetId}`, "success");

        // Beritahu client file ini sukses
        send({ type: "progress", index: idx, file: file.originalname, status: "success", asset_id: assetId, message: `[${idx+1}/${filesToProcess.length}] ✅ ${file.originalname} → ${assetId}` });

      } catch (e) {
        histEntry.error_msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        log(`Attempt ${attempt} failed: ${histEntry.error_msg}`, "error");
        if (e.response?.status === 429) await new Promise(r => setTimeout(r, 10000));
        else if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (!success) {
      send({ type: "progress", index: idx, file: file.originalname, status: "failed", error_msg: histEntry.error_msg, message: `[${idx+1}/${filesToProcess.length}] ❌ Gagal: ${histEntry.error_msg?.slice(0,80)}` });
    }

    db.prepare(`
      INSERT INTO upload_history (id, user_id, filename, asset_id, operation_id, status, error_msg, tempo_multiplier, pitch_shift, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(histEntry.id, histEntry.user_id, histEntry.filename, histEntry.asset_id,
      histEntry.operation_id || null, histEntry.status, histEntry.error_msg,
      histEntry.tempo_multiplier, histEntry.pitch_shift, histEntry.file_size);

    results.push({ ...histEntry, file: file.originalname });

    if (idx < filesToProcess.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  clearInterval(heartbeat);
  send({ type: "done", total: filesToProcess.length, success: successCount, results });
  res.end();
});

app.get("/api/history", requireAuth, (req, res) => {
  const history = db.prepare("SELECT * FROM upload_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.session.userId);
  res.json(history);
});
app.delete("/api/history/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM upload_history WHERE id = ? AND user_id = ?").run(req.params.id, req.session.userId);
  res.json({ success: true });
});

app.get("/api/debug/roblox", requireAuth, (req, res) => {
  const user = db.prepare("SELECT creator_type, roblox_user_id, roblox_group_id, roblox_api_key, roblox_group_api_key FROM users WHERE id=?").get(req.session.userId);
  res.json({
    creator_type: user.creator_type, roblox_user_id: user.roblox_user_id,
    roblox_group_id: user.roblox_group_id, has_api_key: !!(user.roblox_api_key),
    has_group_api_key: !!(user.roblox_group_api_key),
    api_key_preview: user.roblox_api_key ? user.roblox_api_key.slice(0,20)+"..." : null
  });
});

app.get("/ping", (req, res) => res.json({ status: "ok", time: new Date().toISOString(), port: PORT }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.listen(PORT, "0.0.0.0", () => {
  log(`🚀 XELLO SaaS running on port ${PORT}`);
  log(`Tiers: Trial=${TIERS.trial.limit} | Beginner=${TIERS.beginner.limit} | Pro=Unlimited`);
});
