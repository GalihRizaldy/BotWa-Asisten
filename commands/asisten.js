const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../google-credentials.json');
const config = require("../utils");

/**
 * Asisten Keuangan Pintar — Gemini AI + Spreadsheet
 * Mendukung: catat_transaksi, edit_transaksi_terakhir, koreksi_saldo, tanya, chat
 * Usage: >asisten [pesan]
 */

// Helper: Inisialisasi koneksi ke Google Spreadsheet
async function getSheet(sheetId, sheetName) {
  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);
  await doc.loadInfo();
  return doc.sheetsByTitle[sheetName] || doc.sheetsByIndex[0];
}

// Helper: Format Rupiah
function formatRupiah(nominal) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(nominal);
}

// System Prompt untuk ekstraksi JSON (dari instruksi user)
const EXTRACTION_PROMPT = `Kamu adalah asisten pengekstrak data transaksi keuangan. Tugasmu adalah menganalisis pesan pengguna dan mengembalikan output JSON dengan struktur yang ditentukan.

Kategori 'action' yang tersedia:
1. "catat_transaksi" -> Untuk pencatatan pengeluaran atau pemasukan baru biasa.
2. "edit_transaksi_terakhir" -> Jika pengguna ingin mengubah/mengoreksi transaksi yang baru saja dikirim sebelumnya (contoh: "edit transaksi tadi harusnya 15rb dari dana", "eh salah tadi harusnya 20rb dari cash", "revisi transaksi terakhir").
3. "koreksi_saldo" -> Jika pengguna ingin menyesuaikan/set ulang total saldo atau total pemasukan/pengeluaran untuk sumber tertentu (contoh: "sesuaikan update untuk sumber dari cash harusnya pemasukan 300rb pengeluaran 0").
4. "tanya" -> Jika pengguna bertanya tentang data keuangan, laporan, rangkuman, total, atau riwayat transaksi.
5. "chat" -> Jika pesan hanya sapaan atau obrolan biasa yang tidak berhubungan dengan transaksi keuangan.

Aturan Ekstraksi JSON:

A. Jika action = "catat_transaksi":
   - 'tipe': "pemasukan" atau "pengeluaran"
   - 'kategori': nama kategori (misal: makanan, transportasi, kebutuhan, dll)
   - 'keterangan': deskripsi singkat transaksi
   - 'nominal': angka (integer)
   - 'sumber': nama dompet/sumber uang dalam huruf kecil (misal: "cash", "dana", "bank jago", "shopeepay"). Gunakan default "cash" jika tidak disebutkan.

   Aturan Tambahan untuk Pinjaman:
   1. Jika pengguna mengirim pesan pinjaman keluar (contoh: "galih telah melakukan pinjaman 50rb pakai dana", "pinjemin galih 50rb"):
      - 'tipe': "pengeluaran"
      - 'kategori': "pinjaman"
      - 'keterangan': "pinjaman [nama orang]"
      - 'nominal': angka pinjaman
      - 'sumber': sumber dana yang digunakan

   2. Jika pengguna mengirim pesan pengembalian/pembayaran utang (contoh: "galih bayar utang 30rb ke dana", "terima cicilan galih 30rb"):
      - 'tipe': "pemasukan"
      - 'kategori': "bayar_pinjaman"
      - 'keterangan': "bayar pinjaman [nama orang]"
      - 'nominal': angka pembayaran
      - 'sumber': sumber dana tujuan

B. Jika action = "edit_transaksi_terakhir":
   - Extract field yang diubah oleh pengguna (misal: 'nominal': 15000, 'sumber': "dana", 'keterangan', 'kategori', 'tipe').
   - Isikan field yang diubah dengan nilai baru, dan berikan nilai null/kosong pada field yang tidak diubah.
   - Tambahkan field 'is_edit': true.

C. Jika action = "koreksi_saldo":
   - 'sumber': nama sumber uang yang ingin disesuaikan (misal: "cash").
   - 'nominal_pemasukan': angka nominal baru untuk pemasukan (jika ada/disebutkan).
   - 'nominal_pengeluaran': angka nominal baru untuk pengeluaran (jika ada/disebutkan).
   - 'keterangan': "Penyesuaian saldo / koreksi manual".

D. Jika action = "tanya":
   - 'pertanyaan': isi pertanyaan pengguna.

E. Jika action = "chat":
   - 'pesan': isi pesan pengguna.

Output HARUS selalu dalam format JSON valid tanpa teks tambahan di luar JSON.`;

module.exports = {
  name: "asisten",
  description: "Asisten keuangan pintar: catat, edit, koreksi saldo, tanya laporan, atau ngobrol.",
  execute: async (sock, from, args, msg) => {
    const apiKey = config.bot?.gemini_api_key;
    const sheetId = config.bot?.spreadsheet_id;

    if (!apiKey || !sheetId) {
      await sock.sendMessage(from, { text: "Gemini API Key atau Spreadsheet ID belum diatur di file bot.yml." }, { quoted: msg });
      return;
    }

    const prompt = args.join(" ");
    if (!prompt) {
      await sock.sendMessage(from, { text: "Mau ngapain? Contoh:\n- *Catat*: >asisten beli mie gacoan 15rb cash\n- *Edit*: >asisten eh salah tadi harusnya 20rb\n- *Koreksi*: >asisten update saldo cash pemasukan 300rb\n- *Tanya*: >asisten berapa total pengeluaran hari ini?\n- *Chat*: >asisten halo selamat malam" }, { quoted: msg });
      return;
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const waId = msg.key.participant || msg.key.remoteJid;

      // ===== TAHAP 1: KLASIFIKASI + EKSTRAKSI (1 panggilan AI) =====
      const extractModel = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite",
        systemInstruction: EXTRACTION_PROMPT,
      });

      const extractResult = await extractModel.generateContent(prompt);
      let rawText = extractResult.response.text().trim();
      // Bersihkan jika ada tag markdown ```json ... ```
      rawText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      const data = JSON.parse(rawText);

      console.log(`[ASISTEN] Action: "${data.action}" | Data:`, JSON.stringify(data));

      // ===== AKSI 1: CATAT TRANSAKSI BARU =====
      if (data.action === "catat_transaksi") {
        const sheet = await getSheet(sheetId, 'transaksi');
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        await sheet.addRow({
          Timestamp: timestamp,
          WA_ID: waId.split('@')[0],
          Tipe: data.tipe,
          Kategori: data.kategori,
          Keterangan: data.keterangan,
          Nominal: data.nominal,
          Sumber: data.sumber || "cash"
        });

        const emoji = data.tipe === 'pemasukan' ? '💰' : '💸';
        const reply = `${emoji} *Tercatat!*\n\n` +
          `• *${data.tipe.toUpperCase()}*: ${data.keterangan}\n` +
          `• *Nominal*: ${formatRupiah(data.nominal)}\n` +
          `• *Kategori*: ${data.kategori}\n` +
          `• *Sumber*: ${data.sumber || "cash"}\n\n` +
          `_Sudah masuk ke Spreadsheet._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 2: EDIT TRANSAKSI TERAKHIR =====
      } else if (data.action === "edit_transaksi_terakhir") {
        const sheet = await getSheet(sheetId, 'transaksi');
        const rows = await sheet.getRows();
        const userId = waId.split('@')[0];

        // Cari transaksi terakhir milik user ini
        let lastRow = null;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].get('WA_ID') === userId) {
            lastRow = rows[i];
            break;
          }
        }

        if (!lastRow) {
          await sock.sendMessage(from, { text: "Tidak ditemukan transaksi sebelumnya untuk diedit." }, { quoted: msg });
          return;
        }

        // Simpan data lama untuk ditampilkan
        const oldData = {
          tipe: lastRow.get('Tipe'),
          kategori: lastRow.get('Kategori'),
          keterangan: lastRow.get('Keterangan'),
          nominal: lastRow.get('Nominal'),
          sumber: lastRow.get('Sumber')
        };

        // Update hanya field yang diubah (non-null)
        if (data.tipe) lastRow.set('Tipe', data.tipe);
        if (data.kategori) lastRow.set('Kategori', data.kategori);
        if (data.keterangan) lastRow.set('Keterangan', data.keterangan);
        if (data.nominal) lastRow.set('Nominal', data.nominal);
        if (data.sumber) lastRow.set('Sumber', data.sumber);

        await lastRow.save();

        // Buat laporan perubahan
        let changes = [];
        if (data.tipe) changes.push(`Tipe: ${oldData.tipe} → ${data.tipe}`);
        if (data.kategori) changes.push(`Kategori: ${oldData.kategori} → ${data.kategori}`);
        if (data.keterangan) changes.push(`Keterangan: ${oldData.keterangan} → ${data.keterangan}`);
        if (data.nominal) changes.push(`Nominal: ${formatRupiah(Number(oldData.nominal))} → ${formatRupiah(data.nominal)}`);
        if (data.sumber) changes.push(`Sumber: ${oldData.sumber} → ${data.sumber}`);

        const reply = `✏️ *Transaksi Diperbarui!*\n\n` +
          changes.map(c => `• ${c}`).join('\n') +
          `\n\n_Spreadsheet sudah diupdate._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 3: KOREKSI SALDO =====
      } else if (data.action === "koreksi_saldo") {
        const sheet = await getSheet(sheetId, 'transaksi');
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const sumber = data.sumber || "cash";

        // Hitung total saat ini untuk sumber tersebut
        const rows = await sheet.getRows();
        let totalPemasukan = 0;
        let totalPengeluaran = 0;
        rows.forEach(row => {
          if (row.get('Sumber')?.toLowerCase() === sumber.toLowerCase()) {
            const nominal = Number(row.get('Nominal')) || 0;
            if (row.get('Tipe')?.toLowerCase() === 'pemasukan') totalPemasukan += nominal;
            if (row.get('Tipe')?.toLowerCase() === 'pengeluaran') totalPengeluaran += nominal;
          }
        });

        // Tambahkan baris koreksi jika ada selisih
        let koreksiDone = [];

        if (data.nominal_pemasukan !== undefined && data.nominal_pemasukan !== null) {
          const selisihMasuk = data.nominal_pemasukan - totalPemasukan;
          if (selisihMasuk !== 0) {
            await sheet.addRow({
              Timestamp: timestamp,
              WA_ID: waId.split('@')[0],
              Tipe: selisihMasuk >= 0 ? "pemasukan" : "pengeluaran",
              Kategori: "koreksi",
              Keterangan: `Koreksi saldo pemasukan ${sumber} (${formatRupiah(totalPemasukan)} → ${formatRupiah(data.nominal_pemasukan)})`,
              Nominal: Math.abs(selisihMasuk),
              Sumber: sumber
            });
            koreksiDone.push(`Pemasukan ${sumber}: ${formatRupiah(totalPemasukan)} → ${formatRupiah(data.nominal_pemasukan)}`);
          }
        }

        if (data.nominal_pengeluaran !== undefined && data.nominal_pengeluaran !== null) {
          const selisihKeluar = data.nominal_pengeluaran - totalPengeluaran;
          if (selisihKeluar !== 0) {
            await sheet.addRow({
              Timestamp: timestamp,
              WA_ID: waId.split('@')[0],
              Tipe: selisihKeluar >= 0 ? "pengeluaran" : "pemasukan",
              Kategori: "koreksi",
              Keterangan: `Koreksi saldo pengeluaran ${sumber} (${formatRupiah(totalPengeluaran)} → ${formatRupiah(data.nominal_pengeluaran)})`,
              Nominal: Math.abs(selisihKeluar),
              Sumber: sumber
            });
            koreksiDone.push(`Pengeluaran ${sumber}: ${formatRupiah(totalPengeluaran)} → ${formatRupiah(data.nominal_pengeluaran)}`);
          }
        }

        if (koreksiDone.length === 0) {
          await sock.sendMessage(from, { text: `Saldo ${sumber} sudah sesuai, tidak ada koreksi yang diperlukan.` }, { quoted: msg });
        } else {
          const reply = `🔧 *Koreksi Saldo Berhasil!*\n\n` +
            koreksiDone.map(c => `• ${c}`).join('\n') +
            `\n\n_Spreadsheet sudah diupdate._`;
          await sock.sendMessage(from, { text: reply }, { quoted: msg });
        }

      // ===== AKSI 4: TANYA LAPORAN =====
      } else if (data.action === "tanya") {
        const sheet = await getSheet(sheetId, 'transaksi');
        const rows = await sheet.getRows();

        let dataSummary = "DATA TRANSAKSI DI SPREADSHEET:\n";
        if (rows.length === 0) {
          dataSummary += "(Belum ada data transaksi)\n";
        } else {
          rows.forEach((row, i) => {
            dataSummary += `${i + 1}. [${row.get('Timestamp')}] ${row.get('Tipe')} | ${row.get('Kategori')} | ${row.get('Keterangan')} | Rp${row.get('Nominal')} | ${row.get('Sumber')}\n`;
          });
        }

        const qaModel = genAI.getGenerativeModel({
          model: "gemini-3.1-flash-lite",
          systemInstruction: "Kamu adalah asisten laporan keuangan. Jawab pertanyaan pengguna berdasarkan data transaksi yang diberikan. Berikan jawaban yang ringkas, akurat, dan ramah. Gunakan format Rupiah (Rp) untuk angka. Jangan gunakan format markdown seperti ** atau *.",
        });

        const qaResult = await qaModel.generateContent(`${dataSummary}\n\nPERTANYAAN: ${prompt}`);
        const answer = qaResult.response.text().trim();

        await sock.sendMessage(from, { text: `📊 ${answer}` }, { quoted: msg });

      // ===== AKSI 5: NGOBROL BIASA =====
      } else {
        const chatModel = genAI.getGenerativeModel({
          model: "gemini-3.1-flash-lite",
          systemInstruction: "Kamu adalah asisten keuangan yang ramah. Balas sapaan atau obrolan pengguna dengan singkat dan hangat. Jangan gunakan format markdown seperti ** atau *.",
        });

        const chatResult = await chatModel.generateContent(prompt);
        const chatReply = chatResult.response.text().trim();

        await sock.sendMessage(from, { text: chatReply }, { quoted: msg });
      }

    } catch (error) {
      console.error("Asisten Error:", error);
      await sock.sendMessage(from, { text: "Maaf, asisten gagal memproses: " + error.message }, { quoted: msg });
    }
  }
};
