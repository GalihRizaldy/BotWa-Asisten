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

// Helper: Format Rupiah
function formatRupiah(val) {
  const nominal = parseRupiah(val);
  const prefix = nominal < 0 ? "-Rp " : "Rp ";
  return prefix + Math.abs(nominal).toLocaleString('id-ID');
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

      if (frekuensi === 'harian') {
        reminders.push({ nama, nominal, tgl: 'Setiap Hari', type: 'HARI INI' });
        logs.push(`     COCOK (harian)`);
      }
      else if (frekuensi === 'mingguan') {
        logs.push(`     Bandingkan hari: "${tglStr}" vs "${namaHariIni}"`);
        if (tglStr === namaHariIni) {
          reminders.push({ nama, nominal, tgl: `Setiap ${tglStr}`, type: 'HARI INI' });
          logs.push(`     COCOK (mingguan)`);
        } else {
          logs.push(`     TIDAK COCOK`);
        }
      }
      else if (frekuensi === 'bulanan') {
        const tglJatuhTempo = parseInt(tglStr);
        if (tglJatuhTempo) {
          const selisih = tglJatuhTempo - hariIni;
          logs.push(`     Selisih: ${tglJatuhTempo} - ${hariIni} = ${selisih}`);
          if (selisih === 0) {
            reminders.push({ nama, nominal, tgl: tglJatuhTempo, type: 'HARI INI' });
            logs.push(`     COCOK (hari ini)`);
          } else if (selisih === 1 || selisih === 2) {
            reminders.push({ nama, nominal, tgl: tglJatuhTempo, type: `H-${selisih}` });
            logs.push(`     COCOK (H-${selisih})`);
          } else {
            logs.push(`     TIDAK COCOK`);
          }
        }
      }
      else if (frekuensi === 'tahunan') {
        const parts = tglStr.split('/');
        if (parts.length === 2) {
          const tgl = parseInt(parts[0]);
          const bln = parseInt(parts[1]);
          if (bln === bulanIni) {
            const selisih = tgl - hariIni;
            if (selisih === 0) {
              reminders.push({ nama, nominal, tgl: tglStr, type: 'HARI INI' });
              logs.push(`     COCOK (tahunan - hari ini)`);
            } else if (selisih === 1 || selisih === 2) {
              reminders.push({ nama, nominal, tgl: tglStr, type: `H-${selisih}` });
              logs.push(`     COCOK (tahunan - H-${selisih})`);
            } else {
              logs.push(`     TIDAK COCOK (selisih=${selisih})`);
            }
          } else {
            logs.push(`     TIDAK COCOK (bulan beda: ${bln} vs ${bulanIni})`);
          }
        }
      } else {
        logs.push(`     FREKUENSI TIDAK DIKENAL: "${frekuensi}"`);
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
