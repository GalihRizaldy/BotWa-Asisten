const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('./google-credentials.json');
const config = require('./utils');

// Cache agar tidak cek Spreadsheet berulang-ulang untuk user yang sama
const registeredUsers = new Set();

/**
 * Auto-register user ke sheet "Users" jika belum terdaftar.
 * @param {object} sock - WhatsApp socket instance (untuk ambil foto profil)
 * @param {object} msg - Objek pesan dari Baileys
 */
async function registerUser(sock, msg) {
  const sheetId = config.bot?.spreadsheet_id;
  if (!sheetId) return;

  const waId = msg.key.participant || msg.key.remoteJid;
  
  // Jika user sudah pernah dicek dalam sesi ini, skip
  if (registeredUsers.has(waId)) return;

  try {
    const serviceAccountAuth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Users'];
    if (!sheet) {
      console.log("[USERS] Sheet 'Users' tidak ditemukan, skip registrasi.");
      return;
    }

    // Cek apakah WA_ID sudah ada di sheet
    const rows = await sheet.getRows();
    const exists = rows.some(row => row.get('WA_ID') === waId);

    if (exists) {
      // Sudah terdaftar, masukkan ke cache agar tidak cek lagi
      registeredUsers.add(waId);
      console.log(`[USERS] ${waId} sudah terdaftar.`);
      return;
    }

    // Ambil data dari Baileys
    const nama = msg.pushName || "Tidak diketahui";
    const nomorTelepon = waId.split('@')[0];
    const waktuDaftar = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const isGrup = msg.key.remoteJid?.endsWith('@g.us');
    const tipeAkun = isGrup ? "Grup" : "Personal";

    // Coba ambil foto profil
    let linkProfil = "No Photo";
    try {
      linkProfil = await sock.profilePictureUrl(waId, 'image');
    } catch (e) {
      // Foto profil tidak tersedia atau privat
    }

    // Daftarkan user baru
    await sheet.addRow({
      WA_ID: waId,
      Nama: nama,
      Nomor_Telepon: nomorTelepon,
      Waktu_Daftar: waktuDaftar,
      Tipe_Akun: tipeAkun,
      Role: "User",
      Link_Profil: linkProfil
    });

    registeredUsers.add(waId);
    console.log(`[USERS] User baru terdaftar: ${nama} (${waId})`);

  } catch (error) {
    console.error("[USERS] Gagal registrasi user:", error.message);
  }
}

module.exports = { registerUser };
