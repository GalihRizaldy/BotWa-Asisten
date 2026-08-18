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

function startSubscriptionReminder(sock) {
  const sheetId = config.bot?.spreadsheet_id;
  const ownerNumber = config.bot?.owner_number; // Nomor WA owner (misal: "6281234567890")

  if (!sheetId) {
    console.log('[CRON] Spreadsheet ID belum diatur, reminder dinonaktifkan.');
    return;
  }

  // Cron: setiap hari jam 09:00 WIB
  cron.schedule('0 9 * * *', async () => {
    try {
      console.log('[CRON] Menjalankan cek tagihan langganan...');

      const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);
      await doc.loadInfo();

      const sheetLangganan = doc.sheetsByTitle['langganan'] || doc.sheetsByTitle['Langganan'];
      if (!sheetLangganan) {
        console.log('[CRON] Sheet langganan tidak ditemukan.');
        return;
      }

      const rows = await sheetLangganan.getRows();
      const aktifRows = rows.filter(row => {
        const status = (row.get('status') || row.get('Status') || '').toLowerCase();
        return status === 'aktif';
      });

      if (aktifRows.length === 0) return;

      // Tanggal hari ini (WIB)
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
      const hariIni = now.getDate();

      const reminders = [];

      aktifRows.forEach(row => {
        const nama = row.get('nama_layanan') || row.get('Nama_Layanan') || '-';
        const nominal = parseRupiah(row.get('nominal') || row.get('Nominal') || '0');
        const tglJatuhTempo = parseInt(row.get('tanggal_jatuh_tempo') || row.get('Tanggal_Jatuh_Tempo') || '0');

        if (tglJatuhTempo === 0) return;

        // Cek jatuh tempo hari ini atau H-2
        const selisih = tglJatuhTempo - hariIni;
        if (selisih === 0) {
          reminders.push({
            nama,
            nominal,
            tgl: tglJatuhTempo,
            type: 'HARI INI'
          });
        } else if (selisih === 2 || selisih === 1) {
          reminders.push({
            nama,
            nominal,
            tgl: tglJatuhTempo,
            type: `H-${selisih}`
          });
        }
      });

      if (reminders.length === 0) {
        console.log('[CRON] Tidak ada tagihan jatuh tempo hari ini / H-2.');
        return;
      }

      // Kirim pengingat
      // Tentukan tujuan pengiriman: owner atau grup tertentu
      const target = ownerNumber ? `${ownerNumber}@s.whatsapp.net` : null;

      if (!target) {
        console.log('[CRON] owner_number belum diatur di bot.yml, reminder tidak dikirim.');
        return;
      }

      for (const r of reminders) {
        const pesan = `🔔 *PENGINGAT TAGIHAN RUTIN* (${r.type})\n\n` +
          `Tagihan *${r.nama}* sebesar *${formatRupiah(r.nominal)}* jatuh tempo pada tanggal ${r.tgl}.\n\n` +
          `_Ketik \`>asisten bayar ${r.nama.toLowerCase()}\` jika sudah dibayar._`;

        await sock.sendMessage(target, { text: pesan });
        console.log(`[CRON] Reminder terkirim: ${r.nama} (${r.type})`);
      }

    } catch (error) {
      console.error('[CRON] Error cek langganan:', error.message);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Jakarta'
  });

  console.log('[CRON] Subscription reminder aktif — cek setiap hari jam 09:00 WIB.');
}

module.exports = { startSubscriptionReminder };
