# LiberyAudio Simple — Setup Guide

## File Structure
```
libery-simple/
├── server.js              ← Backend utama
├── package.json
├── .env.example           ← Copy ke .env dan isi
├── db.json                ← Database auto-dibuat saat pertama run
└── public/
    ├── index.html         ← Landing page
    ├── login.html         ← Halaman login
    ├── register.html      ← Halaman daftar
    ├── dashboard.html     ← Dashboard user
    ├── admin.html         ← Admin panel
    └── css/
        └── style.css      ← Shared styles
```

---

## Langkah Setup

### 1. Install Node.js (jika belum ada)
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Cek versi
node -v
npm -v
```

### 2. Upload & Install
```bash
# Extract zip
unzip libery-simple.zip
cd libery-simple

# Install dependencies
npm install
```

### 3. Setup .env
```bash
cp .env.example .env
nano .env
```
Isi nilainya:
```
SESSION_SECRET=random-string-panjang-bebas-isi-apa-saja
ENCRYPT_KEY=tepat32karaktersajatidakkurang!!
ADMIN_SEED_SECRET=password-untuk-buat-admin
PORT=3000
```
> ⚠️ ENCRYPT_KEY harus TEPAT 32 karakter!

### 4. Jalankan Server
```bash
node server.js
```
Buka: http://localhost:3000

### 5. Buat Akun Admin Pertama
```bash
curl -X POST http://localhost:3000/api/seed-admin \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "seed-libery-2024",
    "username": "admin",
    "password": "passwordAdmin123",
    "email": "admin@email.com"
  }'
```
Atau pakai Postman / browser extension.

Setelah itu login di `/login` dengan username `admin`.

---

## Deploy ke Server (Betabotz Pro 1)

### Jalankan dengan PM2 (agar tidak mati)
```bash
# Install PM2
npm install -g pm2

# Jalankan
pm2 start server.js --name libery-audio

# Auto-start saat server reboot
pm2 save
pm2 startup
```

### Setup Nginx (opsional, untuk domain)
```nginx
server {
    listen 80;
    server_name domain-kamu.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Cara Kerja Admin Panel

### Akses Admin
- Login dengan akun admin → otomatis redirect ke `/admin`
- Atau akses langsung `/admin` saat sudah login sebagai admin

### Kelola Plan User
1. **Cepat dari tabel** — klik tombol `+7hr`, `+30hr`, atau `Free` langsung
2. **Form Aktifkan Plan** — masukkan username + pilih paket → klik Aktifkan
3. **Edit User modal** — klik ✏️ pada baris user → ubah plan, durasi, dan role

### Reset Password User
- Klik 🔑 pada baris user → masukkan password baru → simpan

### Hapus User
- Klik 🗑 → konfirmasi → user dan semua data dihapus permanen

---

## Alur Upgrade User (Manual)

```
1. User minta upgrade (WA/Discord ke admin)
2. User transfer pembayaran
3. Admin login → buka Admin Panel → Kelola Plan
4. Cari username user → aktifkan paket sesuai yang dibeli
5. User refresh dashboard → plan langsung aktif
```

---

## Catatan Penting

- `db.json` adalah database sederhana dalam format JSON
- Backup file `db.json` secara berkala!
- API Key Roblox user tersimpan terenkripsi AES-256
- Session bertahan 7 hari sebelum perlu login ulang
