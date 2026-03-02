# ⚡ XELLO STUDIO v2.0 - Roblox Audio Uploader SaaS

## 📋 FITUR
- ✅ Landing page profesional
- ✅ Register/Login dengan username & password
- ✅ Sistem tier: Trial (3) / Beginner (50) / Pro (Unlimited) upload/bulan
- ✅ Upload audio bulk ke Roblox (Personal & Group)
- ✅ Audio preview + waveform visualizer
- ✅ Tempo & pitch processor
- ✅ Kode invite untuk upgrade tier
- ✅ Admin panel lengkap (manage user, buat kode invite)
- ✅ Database SQLite (tidak perlu setup eksternal)

---

## 🚀 CARA INSTALL DI DANBOT HOSTING

### Langkah 1: Upload file
Upload semua file ke server lewat tab **Files** di Pterodactyl panel.

Struktur folder yang harus ada:
```
/home/container/
├── server.js
├── package.json
├── .env
├── public/
│   ├── index.html
│   ├── dashboard.html
│   └── admin.html
└── data/          (akan dibuat otomatis)
```

### Langkah 2: Edit file .env
Buka file `.env` dan sesuaikan:

```env
PORT=1179
SESSION_SECRET=ganti_dengan_string_acak_panjang_ini

ADMIN_USERNAME=admin
ADMIN_PASSWORD=password_admin_kamu_disini

TIER_TRIAL_LIMIT=3
TIER_BEGINNER_LIMIT=50
TIER_PRO_LIMIT=999999
```

### Langkah 3: Install dependencies
Di console Pterodactyl, jalankan:
```bash
npm install
```

### Langkah 4: Start server
```bash
node server.js
```

Atau set startup command di Pterodactyl menjadi:
```
node server.js
```

---

## 🌐 AKSES

| Halaman | URL |
|---------|-----|
| Landing Page | `http://pnode1.danbot.host:1179` |
| Dashboard User | `http://pnode1.danbot.host:1179/dashboard` |
| Admin Panel | `http://pnode1.danbot.host:1179/admin` |

---

## 🔑 LOGIN ADMIN

Buka `/admin` dan login dengan:
- Username: sesuai `ADMIN_USERNAME` di .env
- Password: sesuai `ADMIN_PASSWORD` di .env

---

## 🎫 CARA BUAT KODE INVITE

1. Login ke Admin Panel (`/admin`)
2. Klik menu **Invite Codes**
3. Pilih tier (Beginner/Pro), max uses, dan expiry
4. Klik **BUAT KODE**
5. Bagikan kode ke user yang mau diupgrade

User bisa redeem kode di:
- Saat **Register** (langsung dapat tier)
- Di **Dashboard → Settings → Invite Code**

---

## ⚙️ CARA USER SETUP

1. Daftar akun di landing page
2. Login ke dashboard
3. Pergi ke **Settings → Roblox**
4. Pilih Personal atau Group Account
5. Masukkan User ID + API Key
6. Upload audio!

---

## 🔧 CATATAN PENTING

- **FFmpeg**: Fitur tempo/pitch processing butuh FFmpeg terinstall di server. Jika tidak ada, upload tetap berjalan tapi tanpa processing audio.
- **Database**: Data disimpan di `data/xello.sqlite` — jangan hapus folder ini!
- **Session**: User harus login ulang jika server restart.

---

## 📞 SUPPORT

Jika ada error, cek console log di Pterodactyl panel.
