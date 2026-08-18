# Bot WA Asisten Keuangan Pribadi (bot-wa-finansial) 🤖💰

![Version](https://img.shields.io/badge/version-0.1.17-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)
![Baileys](https://img.shields.io/badge/Baileys-WhatsApp_Engine-25D366.svg)
![Gemini AI](https://img.shields.io/badge/AI-Google_Gemini-4285F4.svg)
![Google Sheets](https://img.shields.io/badge/Database-Google_Sheets-0F9D58.svg)

Asisten finansial cerdas berbasis WhatsApp yang memadukan **Gemini AI** untuk pemrosesan bahasa alami (NLP / Intent Extraction) dan **Google Sheets** sebagai database real-time. Bot ini memungkinkan Anda mencatat pengeluaran, memantau saldo dompet, mengelola utang piutang, dan membuat laporan bulanan hanya dengan mengirim pesan chat biasa layaknya ngobrol dengan manusia.

---

## 🛠 Tech Stack

- **Runtime:** Node.js (>= 18)
- **WhatsApp Engine:** [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) (Web socket library)
- **AI Engine:** Google Gemini API (Natural Language Processing & JSON extraction)
- **Database:** Google Sheets (via `google-spreadsheet` library & Google Service Account)
- **Process Manager:** PM2 (Untuk production deployment)
- **Timezone:** Asia/Jakarta (WIB)

---

## 🗂 Struktur Database (Google Sheets)

Project ini menggunakan Google Sheets sebagai sistem basis data. Anda harus menyiapkan 4 worksheet (sheet) dengan rincian berikut:

| Nama Sheet | Deskripsi & Kegunaan |
|---|---|
| **`transaksi`** | Log pencatatan transaksi (masuk/keluar), nominal, kategori, timestamp (WIB), sumber dompet, dan WA ID. |
| **`keuangan`** | Rekap real-time saldo per dompet (Cash, DANA, Bank Jago, dll) menggunakan rumus dinamis dari sheet `transaksi`. |
| **`pinjaman`** | Rekap daftar utang/piutang per nama orang, mencakup kolom nominal pinjam, pembayaran, sisa piutang, dan status (LUNAS/BELUM LUNAS). |
| **`laporan_bulanan`** | Arsip rekap keuangan bulanan (Pemasukan, Pengeluaran, Cashflow, Breakdown Kategori, Snapshot Saldo) yang otomatis di-insert/update oleh bot saat Anda meminta rekap. |

---

## ✨ Fitur Utama & Contoh Perintah Chat

Bot dilengkapi dengan AI yang cerdas mengenali maksud (intent) dari kalimat Anda. Cukup gunakan prefix bot (misal: `>asisten`) diikuti kalimat natural.

### 1. Pencatatan Transaksi Natural
AI akan mengekstrak nominal, tipe, kategori, dan dompet secara otomatis.
> **User:** `>asisten beli makan siang ayam geprek 15rb cash`  
> **Bot:** Akan mencatat pengeluaran 15.000 ke kategori "makanan" dari saldo "cash".

### 2. Rekap & Laporan Bulanan Otomatis
Mengambil data transaksi, menghitung cashflow, dan membuat breakdown persentase pengeluaran per kategori.
> **User:** `>asisten laporan keuangan bulan ini`  
> **Bot:** Akan mengkalkulasi bulan berjalan, lalu menyimpan hasilnya ke sheet `laporan_bulanan` dan membalas dengan ringkasan lengkap.

### 3. Manajemen Utang / Piutang (Anti-NaN)
Bot secara aman memparsing format angka (seperti Rp, titik, minus) dari sheet `pinjaman`.
> **User:** `>asisten cek utang galih` atau `>asisten siapa saja yang utang?`  
> **Bot:** Membaca status sheet `pinjaman` secara real-time dan menampilkan daftar utang/piutang.

### 4. Pembatalan (Undo) Transaksi
Hapus transaksi yang tidak sengaja terinput tanpa harus repot membuka Google Sheets.
> **User:** `>asisten batal` atau `>asisten undo transaksi terakhir`  
> **Bot:** Menghapus baris transaksi paling terakhir dari pengguna terkait dan mengembalikan saldo otomatis.

---

## 🚀 Panduan Instalasi & Deployment

### Prasyarat:
- Node.js versi 18 atau lebih baru
- Kredensial akun Google Cloud Service Account (`google-credentials.json`)
- API Key Google Gemini (dari Google AI Studio)
- ID Google Spreadsheet (ambil dari URL Sheets Anda)

### Setup Local / VPS:

1. **Clone Repository**
   ```bash
   git clone https://github.com/GalihRizaldy/BotWa-Asisten.git
   cd BotWa-Asisten
   ```

2. **Install Dependensi**
   ```bash
   npm install
   ```

3. **Konfigurasi Kredensial & Env**
   - Salin/buat file `bot.yml` menggunakan panduan dari `bot.yml.example`, lalu isi `gemini_api_key` dan `spreadsheet_id`.
   - Taruh file kredensial Google Service Account Anda di folder root proyek dengan nama `google-credentials.json`.
   - **Pastikan** Service Account Email telah diundang (Share) sebagai **Editor** pada Google Spreadsheet Anda.

4. **Jalankan Bot (Development)**
   ```bash
   npm start
   ```
   *Buka console terminal dan scan QR Code yang muncul menggunakan WhatsApp (Linked Devices).*

5. **Deployment Production (menggunakan PM2)**
   Sangat disarankan menggunakan PM2 di server VPS (misal: Ubuntu) agar bot terus berjalan di background.
   ```bash
   npm install -g pm2
   pm2 start index.js --name bot-wa-finansial
   pm2 save
   pm2 startup
   ```

---
*Dibuat untuk memudahkan pengelolaan keuangan dengan kecanggihan AI langsung di saku Anda.*
