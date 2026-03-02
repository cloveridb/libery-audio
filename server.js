require('dotenv').config()
const express  = require('express')
const session  = require('express-session')
const bcrypt   = require('bcryptjs')
const path     = require('path')
const crypto   = require('crypto')
const fs       = require('fs')
const multer   = require('multer')

const app = express()

// ============================================================
// DATABASE (JSON — simpel, tidak perlu install apapun)
// ============================================================
const DB_FILE = path.join(__dirname, 'db.json')

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const init = { users: {}, conversions: {} }
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2))
    return init
  }
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }
  catch { return { users: {}, conversions: {} } }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
}

function getUser(username) {
  return loadDB().users[username.toLowerCase()] || null
}

function getUserById(id) {
  const db = loadDB()
  return Object.values(db.users).find(u => u.id === id) || null
}

function saveUser(username, data) {
  const db = loadDB()
  const key = username.toLowerCase()
  db.users[key] = { ...db.users[key], ...data }
  saveDB(db)
  return db.users[key]
}

function getAllUsers() {
  return Object.values(loadDB().users)
}

// ============================================================
// ENCRYPT / DECRYPT API KEY
// ============================================================
const ENC_KEY = (process.env.ENCRYPT_KEY || 'liberyaudio_key_change_this_32ch!').slice(0, 32)

function encrypt(text) {
  if (!text) return ''
  const iv     = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENC_KEY), iv)
  const enc    = Buffer.concat([cipher.update(text), cipher.final()])
  return iv.toString('hex') + ':' + enc.toString('hex')
}

function decrypt(text) {
  if (!text) return ''
  try {
    const [ivHex, encHex] = text.split(':')
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENC_KEY), Buffer.from(ivHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString()
  } catch { return '' }
}

// ============================================================
// HELPERS
// ============================================================
function getTodayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`
}

function getRemainingToday(user) {
  if (user.plan === 'pro') return 999
  if (!user.plan || user.plan === 'free') {
    const today = getTodayKey()
    if (user.dailyReset !== today) return 3
    return Math.max(0, 3 - (user.dailyUsed || 0))
  }
  return 0
}

function isPlanActive(user) {
  if (user.plan === 'free' || !user.plan) return true
  if (user.plan === 'pro') {
    if (!user.planExpiry) return false
    return new Date(user.planExpiry) > new Date()
  }
  return false
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))
app.use(session({
  secret: process.env.SESSION_SECRET || 'libery-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}))

// Auth check middlewares
function requireLogin(req, res, next) {
  if (req.session.userId) return next()
  res.redirect('/login')
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login')
  const user = getUserById(req.session.userId)
  if (!user || user.role !== 'admin') return res.redirect('/dashboard')
  next()
}

// ============================================================
// STATIC PAGES
// ============================================================
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
app.get('/login',    (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard')
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
})
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard')
  res.sendFile(path.join(__dirname, 'public', 'register.html'))
})
app.get('/dashboard', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')))
app.get('/admin',     requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')))

// ============================================================
// AUTH API
// ============================================================

// REGISTER
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body
  if (!username || !email || !password)
    return res.json({ success: false, error: 'Semua field wajib diisi' })
  if (password.length < 6)
    return res.json({ success: false, error: 'Password minimal 6 karakter' })

  const existing = getUser(username)
  if (existing)
    return res.json({ success: false, error: 'Username sudah digunakan' })

  // Cek email juga
  const emailUsed = getAllUsers().find(u => u.email === email.toLowerCase())
  if (emailUsed)
    return res.json({ success: false, error: 'Email sudah terdaftar' })

  const hash = await bcrypt.hash(password, 10)
  const id   = crypto.randomUUID()

  saveUser(username, {
    id,
    username:        username.toLowerCase(),
    email:           email.toLowerCase(),
    passwordHash:    hash,
    role:            'user',
    plan:            'free',
    planExpiry:      null,
    robloxUserId:    null,
    robloxApiKeyEnc: null,
    totalConversions: 0,
    dailyUsed:        0,
    dailyReset:       getTodayKey(),
    conversions:      [],
    createdAt:        new Date().toISOString(),
  })

  req.session.userId = id
  res.json({ success: true })
})

// LOGIN
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password)
    return res.json({ success: false, error: 'Username dan password wajib diisi' })

  const user = getUser(username)
  if (!user)
    return res.json({ success: false, error: 'Username atau password salah' })

  const match = await bcrypt.compare(password, user.passwordHash)
  if (!match)
    return res.json({ success: false, error: 'Username atau password salah' })

  // Cek plan expiry
  if (user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) < new Date()) {
    saveUser(user.username, { plan: 'free', planExpiry: null })
  }

  req.session.userId = user.id
  const isAdmin = user.role === 'admin'
  res.json({ success: true, redirect: isAdmin ? '/admin' : '/dashboard' })
})

// LOGOUT
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }))
})

// ============================================================
// USER API
// ============================================================

// GET me
app.get('/api/me', requireLogin, (req, res) => {
  const user = getUserById(req.session.userId)
  if (!user) return res.status(404).json({ error: 'User not found' })

  // Auto-expire plan
  if (user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) < new Date()) {
    saveUser(user.username, { plan: 'free', planExpiry: null })
    user.plan = 'free'
  }

  res.json({
    username:         user.username,
    email:            user.email,
    plan:             user.plan || 'free',
    planExpiry:       user.planExpiry,
    robloxConnected:  !!user.robloxUserId,
    robloxUserId:     user.robloxUserId,
    totalConversions: user.totalConversions || 0,
    remainingToday:   getRemainingToday(user),
    conversions:      (user.conversions || []).slice(0, 20),
    role:             user.role,
  })
})

// Save Roblox account
app.post('/api/roblox', requireLogin, (req, res) => {
  const { userId, apiKey, groupId } = req.body
  if (!userId) return res.json({ success: false, error: 'User ID wajib diisi' })

  const user = getUserById(req.session.userId)
  const updates = { robloxUserId: userId }
  if (groupId) updates.robloxGroupId = groupId
  if (apiKey && apiKey.trim()) updates.robloxApiKeyEnc = encrypt(apiKey.trim())

  saveUser(user.username, updates)
  res.json({ success: true })
})

// Convert audio (mock — implementasi FFmpeg di sini nanti)
app.post('/api/convert', requireLogin, (req, res) => {
  const user = getUserById(req.session.userId)
  if (!user.robloxUserId)
    return res.json({ success: false, error: 'Hubungkan akun Roblox dulu di halaman Akun' })

  const remaining = getRemainingToday(user)
  if (remaining <= 0)
    return res.json({ success: false, error: 'Limit harian habis. Upgrade ke Pro untuk unlimited.' })

  const { url, speed = 2.0, amplify = -4, duration = 350 } = req.body

  // Update daily counter
  const today = getTodayKey()
  const dailyUsed = (user.dailyReset === today ? (user.dailyUsed || 0) : 0) + 1

  // Mock asset ID — ganti dengan FFmpeg + Roblox API upload nanti
  const assetId = Math.floor(Math.random() * 900000000000000) + 100000000000000

  const conv = {
    id:        Date.now().toString(),
    name:      url ? url.replace(/^https?:\/\//,'').substring(0, 50) : 'File Upload',
    assetId,
    speed:     parseFloat(speed),
    amplify:   parseInt(amplify),
    status:    'pending',
    createdAt: new Date().toISOString(),
  }

  const updatedUser = getUserById(req.session.userId)
  const conversions = [conv, ...(updatedUser.conversions || [])].slice(0, 100)

  saveUser(user.username, {
    dailyUsed,
    dailyReset:       today,
    totalConversions: (updatedUser.totalConversions || 0) + 1,
    conversions,
  })

  res.json({ success: true, conversion: conv })
})

// ============================================================
// ADMIN API
// ============================================================

// Get all users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = getAllUsers().map(u => ({
    id:               u.id,
    username:         u.username,
    email:            u.email,
    plan:             u.plan || 'free',
    planExpiry:       u.planExpiry,
    robloxConnected:  !!u.robloxUserId,
    robloxUserId:     u.robloxUserId,
    totalConversions: u.totalConversions || 0,
    role:             u.role,
    createdAt:        u.createdAt,
    active:           isPlanActive(u),
  }))
  res.json({ users })
})

// Set plan user
app.post('/api/admin/set-plan', requireAdmin, (req, res) => {
  const { username, plan, days } = req.body
  if (!username || !plan) return res.json({ success: false, error: 'username dan plan wajib diisi' })

  const user = getUser(username)
  if (!user) return res.json({ success: false, error: 'User tidak ditemukan' })

  let planExpiry = null
  if (plan === 'pro') {
    const exp = new Date()
    exp.setDate(exp.getDate() + (parseInt(days) || 30))
    planExpiry = exp.toISOString()
  }

  saveUser(username, { plan, planExpiry })
  res.json({ success: true, plan, planExpiry })
})

// Set role (jadikan admin)
app.post('/api/admin/set-role', requireAdmin, (req, res) => {
  const { username, role } = req.body
  if (!username || !role) return res.json({ success: false, error: 'username dan role wajib diisi' })

  const user = getUser(username)
  if (!user) return res.json({ success: false, error: 'User tidak ditemukan' })

  saveUser(username, { role })
  res.json({ success: true })
})

// Reset password user
app.post('/api/admin/reset-password', requireAdmin, async (req, res) => {
  const { username, newPassword } = req.body
  if (!username || !newPassword) return res.json({ success: false, error: 'Semua field wajib diisi' })

  const user = getUser(username)
  if (!user) return res.json({ success: false, error: 'User tidak ditemukan' })

  const hash = await bcrypt.hash(newPassword, 10)
  saveUser(username, { passwordHash: hash })
  res.json({ success: true })
})

// Delete user
app.delete('/api/admin/user/:username', requireAdmin, (req, res) => {
  const db = loadDB()
  const key = req.params.username.toLowerCase()
  if (!db.users[key]) return res.json({ success: false, error: 'User tidak ditemukan' })
  delete db.users[key]
  saveDB(db)
  res.json({ success: true })
})

// Admin stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users = getAllUsers()
  res.json({
    totalUsers:    users.length,
    proUsers:      users.filter(u => u.plan === 'pro' && isPlanActive(u)).length,
    freeUsers:     users.filter(u => !u.plan || u.plan === 'free').length,
    totalConversions: users.reduce((s, u) => s + (u.totalConversions || 0), 0),
  })
})

// ============================================================
// SEED ADMIN (jalankan sekali)
// POST /api/seed-admin  body: { secret: "...", username: "...", password: "..." }
// ============================================================
app.post('/api/seed-admin', async (req, res) => {
  const { secret, username, password, email } = req.body
  if (secret !== (process.env.ADMIN_SEED_SECRET || 'seed-libery-2024'))
    return res.status(403).json({ error: 'Forbidden' })

  const existing = getUser(username)
  if (existing) {
    saveUser(username, { role: 'admin' })
    return res.json({ success: true, message: 'Role updated to admin' })
  }

  const hash = await bcrypt.hash(password, 10)
  saveUser(username, {
    id:           crypto.randomUUID(),
    username:     username.toLowerCase(),
    email:        (email || username + '@admin.local').toLowerCase(),
    passwordHash: hash,
    role:         'admin',
    plan:         'pro',
    planExpiry:   null,
    createdAt:    new Date().toISOString(),
    conversions:  [],
    totalConversions: 0,
  })

  res.json({ success: true, message: 'Admin created' })
})

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════╗
║  LiberyAudio - Simple          ║
║  http://localhost:${PORT}          ║
║                                ║
║  Buat admin pertama:           ║
║  POST /api/seed-admin          ║
║  { secret, username,           ║
║    password, email }           ║
╚════════════════════════════════╝`)
})
