const cron = require('node-cron');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('./google-credentials.json');
const config = require('./utils');

/**
 * Subscription Reminder - Cron Job
 * Berjalan setiap hari jam 09:00 WIB
 * Mengirim pengingat tagihan yang jatuh tempo hari ini atau H-2
 */

// Helper: Bersihkan string angka dari format mata uang Rupiah
function parseRupiah(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return val;
  const cleaned = val.toString().replace(/[^0-9-]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

function formatRupiah(val) {
  const nominal = parseRupiah(val);
  const prefix = nominal < 0 ? "-Rp " : "Rp ";
  return prefix + Math.abs(nominal).toLocaleString('id-ID');
}

// Helper: Menghitung selisih hari dari hari ini ke target jatuh tempo
function getDaysUntil(frekuensi, jatuhTempoStr) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (frekuensi === 'harian') return 0;
  
  if (frekuensi === 'mingguan') {
    const hari = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
    const targetIdx = hari.indexOf((jatuhTempoStr || '').toLowerCase().trim());
    if (targetIdx === -1) return -1;
    
    const todayIdx = today.getDay();
    let diff = targetIdx - todayIdx;
    if (diff < 0) diff += 7;
    return diff;
  }
  
  if (frekuensi === 'bulanan') {
    const targetDate = parseInt(jatuhTempoStr, 10);
    if (isNaN(targetDate)) return -1;
    
    let month = today.getMonth();
    let year = today.getFullYear();
    
    let lastDayThisMonth = new Date(year, month + 1, 0).getDate();
    let validTargetDate = Math.min(targetDate, lastDayThisMonth);
    let target = new Date(year, month, validTargetDate);
    
    if (target < today) {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      let lastDayNextMonth = new Date(year, month + 1, 0).getDate();
      validTargetDate = Math.min(targetDate, lastDayNextMonth);
      target = new Date(year, month, validTargetDate);
    }
    
    const diffTime = target.getTime() - today.getTime();
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
  }
  
  if (frekuensi === 'tahunan') {
    const parts = (jatuhTempoStr || '').split('/');
    if (parts.length !== 2) return -1;
    const d = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    if (isNaN(d) || isNaN(m)) return -1;
    
    let year = today.getFullYear();
    let target = new Date(year, m, d);
    
    if (target < today) {
      target = new Date(year + 1, m, d);
    }
    
    const diffTime = target.getTime() - today.getTime();
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
  }
  
  return -1;
}

/**
 * Fungsi utama: cek langganan & kirim reminder.
 * Bisa dipanggil dari cron maupun dari command test_cron.
 * @param {object} sock - Baileys socket
 * @param {string|null} debugTarget - Jika diisi, kirim laporan debug ke JID ini (untuk testing)
 */
async function runReminderCheck(sock, debugTarget = null) {
  const sheetId = config.bot?.spreadsheet_id;
  const ownerNumber = config.bot?.owner_number;
  const logs = []; // Kumpulkan log untuk debug

  logs.push(`[1/6] Mulai cek langganan...`);
  logs.push(`[2/6] Spreadsheet ID: ${sheetId ? 'OK' : 'TIDAK ADA'}`);
  logs.push(`[2/6] Owner Number: ${ownerNumber || 'TIDAK ADA'}`);

  if (!sheetId) {
    logs.push(`[GAGAL] spreadsheet_id belum diatur di bot.yml.`);
    if (debugTarget) await sock.sendMessage(debugTarget, { text: logs.join('\n') });
    return;
  }

  try {
    const serviceAccountAuth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);
    await doc.loadInfo();
    logs.push(`[3/6] Google Sheets terhubung: "${doc.title}"`);

    const sheetLangganan = doc.sheetsByTitle['langganan'] || doc.sheetsByTitle['Langganan'];
    if (!sheetLangganan) {
      logs.push(`[GAGAL] Sheet 'langganan' tidak ditemukan.`);
      if (debugTarget) await sock.sendMessage(debugTarget, { text: logs.join('\n') });
      return;
    }

    const rows = await sheetLangganan.getRows();
    const aktifRows = rows.filter(row => {
      const status = (row.get('status') || row.get('Status') || '').toLowerCase();
      return status === 'aktif';
    });

    logs.push(`[4/6] Total baris: ${rows.length}, Aktif: ${aktifRows.length}`);

    if (aktifRows.length === 0) {
      logs.push(`[SELESAI] Tidak ada langganan aktif.`);
      if (debugTarget) await sock.sendMessage(debugTarget, { text: logs.join('\n') });
      return;
    }

    // Tanggal hari ini (WIB)
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const hariIni = now.getDate();
    const bulanIni = now.getMonth() + 1;
    const namaHariIni = now.toLocaleDateString('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta' }).toLowerCase();

    logs.push(`[5/6] Hari ini: ${namaHariIni}, Tanggal: ${hariIni}, Bulan: ${bulanIni}`);

    const reminders = [];

    aktifRows.forEach(row => {
      const nama = row.get('nama_layanan') || row.get('Nama_Layanan') || '-';
      const nominal = parseRupiah(row.get('nominal') || row.get('Nominal') || '0');
      const frekuensi = (row.get('frekuensi') || row.get('Frekuensi') || 'bulanan').toLowerCase();
      const tglStr = (row.get('tanggal_jatuh_tempo') || row.get('Tanggal_Jatuh_Tempo') || '').toString().toLowerCase();

      logs.push(`  -> "${nama}" | frekuensi=${frekuensi} | jatuh_tempo=${tglStr} | nominal=${nominal}`);

      const diffDays = getDaysUntil(frekuensi, tglStr);
      let shouldRemind = false;
      let teksHari = "";

      if (frekuensi === 'bulanan' || frekuensi === 'tahunan') {
          if ([0, 1, 2, 3].includes(diffDays)) {
              shouldRemind = true;
              teksHari = diffDays === 0 ? "HARI INI" : `H-${diffDays}`;
          }
      } else if (frekuensi === 'mingguan') {
          if ([0, 1].includes(diffDays)) {
              shouldRemind = true;
              teksHari = diffDays === 0 ? "HARI INI" : `H-${diffDays}`;
          }
      } else if (frekuensi === 'harian') {
          shouldRemind = true;
          teksHari = "HARI INI";
      }

      if (shouldRemind) {
          reminders.push({ nama, nominal, tgl: tglStr, type: teksHari });
          logs.push(`     COCOK (${teksHari})`);
      } else {
          logs.push(`     TIDAK COCOK (diffDays=${diffDays})`);
      }
    });

    logs.push(`[6/6] Total reminder yang cocok: ${reminders.length}`);

    if (reminders.length === 0) {
      logs.push(`[SELESAI] Tidak ada tagihan jatuh tempo hari ini.`);
      console.log('[CRON] Tidak ada tagihan jatuh tempo hari ini / H-2.');
      if (debugTarget) await sock.sendMessage(debugTarget, { text: logs.join('\n') });
      return;
    }

    // Tentukan target pengiriman
    let target = null;
    if (ownerNumber) {
      const raw = ownerNumber.toString().trim();
      if (raw.includes('@')) {
        // Hapus nomor device spesifik (misal :9@lid -> @lid) agar pesan terkirim & terdekripsi di SEMUA device (HP Android + WA Web)
        target = raw.replace(/:\d+@/, '@');
      } else {
        target = `${raw}@s.whatsapp.net`;
      }
    }

    if (!target) {
      logs.push(`[GAGAL] owner_number belum diatur di bot.yml.`);
      console.log('[CRON] owner_number belum diatur di bot.yml, reminder tidak dikirim.');
      if (debugTarget) await sock.sendMessage(debugTarget, { text: logs.join('\n') });
      return;
    }

    logs.push(`Target kirim: ${target}`);

    // Kirim debug log terlebih dahulu (jika ada)
    if (debugTarget) {
      await sock.sendMessage(debugTarget, { text: `🔍 *DEBUG REMINDER*\n\n${logs.join('\n')}` });
    }

    // Kirim reminder
    for (const r of reminders) {
      const pesan = `🔔 *PENGINGAT TAGIHAN RUTIN* (${r.type})\n\n` +
        `Tagihan *${r.nama}* sebesar *${formatRupiah(r.nominal)}* jatuh tempo pada tanggal ${r.tgl}.\n\n` +
        `_Ketik \`>asisten bayar ${r.nama.toLowerCase()}\` jika sudah dibayar._`;

      await sock.sendMessage(target, { text: pesan });
      console.log(`[CRON] Reminder terkirim: ${r.nama} (${r.type})`);
    }

  } catch (error) {
    console.error('[CRON] Error cek langganan:', error.message);
    logs.push(`[ERROR] ${error.message}`);
    if (debugTarget) {
      await sock.sendMessage(debugTarget, { text: `❌ *ERROR REMINDER*\n\n${logs.join('\n')}` });
    }
  }
}

// Simpan referensi sock yang bisa di-update saat reconnect
let currentSock = null;
let cronTask = null;

function startSubscriptionReminder(sock) {
  // Selalu update sock ke yang terbaru
  currentSock = sock;

  // Jika cron sudah pernah dibuat, cukup update sock saja (jangan buat cron baru)
  if (cronTask) {
    console.log('[CRON] Sock diperbarui (reconnect). Cron tetap berjalan.');
    return;
  }

  // Cron: setiap hari jam 09:00 WIB
  cronTask = cron.schedule('0 9 * * *', async () => {
    console.log('[CRON] Menjalankan cek tagihan langganan...');
    if (!currentSock) {
      console.log('[CRON] Sock belum tersedia, skip.');
      return;
    }
    await runReminderCheck(currentSock);
  }, {
    scheduled: true,
    timezone: 'Asia/Jakarta',
    recoverMissedExecutions: true
  });

  console.log('[CRON] Subscription reminder aktif — cek setiap hari jam 09:00 WIB.');
}

module.exports = { startSubscriptionReminder, runReminderCheck };
