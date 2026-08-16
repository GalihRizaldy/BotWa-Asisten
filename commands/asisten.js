const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../google-credentials.json');
const config = require("../utils");

/**
 * Asisten Keuangan Pintar — Gemini AI + Spreadsheet
 * Mendukung: catat_transaksi, edit_transaksi_terakhir, koreksi_saldo, rekap_bulanan, tanya, chat
 * Usage: >asisten [pesan]
 */

// Helper: Inisialisasi koneksi ke Google Spreadsheet
async function getDoc(sheetId) {
  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}

async function getSheet(sheetId, sheetName) {
  const doc = await getDoc(sheetId);
  return doc.sheetsByTitle[sheetName] || doc.sheetsByIndex[0];
}

// Helper: Mapping nama bulan Indonesia
const NAMA_BULAN = {
  'januari': 1, 'februari': 2, 'maret': 3, 'april': 4,
  'mei': 5, 'juni': 6, 'juli': 7, 'agustus': 8,
  'september': 9, 'oktober': 10, 'november': 11, 'desember': 12
};
const BULAN_LABEL = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// Helper: Parse timestamp ke { bulan (1-12), tahun }
// Mendukung format: "2026-08-16 ..." (ISO) dan "8/16/2026 ..." atau "16/8/2026" (lokal)
function parseTimestampMonth(ts) {
  if (!ts) return null;
  const str = String(ts).trim();

  // ISO: 2026-08-16 atau 2026-08-16T...
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) return { bulan: parseInt(isoMatch[2]), tahun: parseInt(isoMatch[1]) };

  // Lokal ID: 16/8/2026 atau 8/16/2026
  const localMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (localMatch) {
    const a = parseInt(localMatch[1]);
    const b = parseInt(localMatch[2]);
    const y = parseInt(localMatch[3]);
    // Jika angka pertama > 12 pasti tanggal (format d/m/y)
    if (a > 12) return { bulan: b, tahun: y };
    // Jika angka kedua > 12 pasti tanggal (format m/d/y)
    if (b > 12) return { bulan: a, tahun: y };
    // Default: anggap m/d/y (format JS toLocaleString)
    return { bulan: a, tahun: y };
  }

  // Fallback: coba parse dengan Date
  const d = new Date(str);
  if (!isNaN(d.getTime())) return { bulan: d.getMonth() + 1, tahun: d.getFullYear() };

  return null;
}

// Helper: Parse string bulan dari AI (misal "Agustus 2026") ke { bulan, tahun }
function parseBulanRequest(bulanStr) {
  const now = new Date();
  if (!bulanStr) return { bulan: now.getMonth() + 1, tahun: now.getFullYear() };

  const lower = bulanStr.toLowerCase().trim();
  for (const [nama, num] of Object.entries(NAMA_BULAN)) {
    if (lower.includes(nama)) {
      const yearMatch = lower.match(/(\d{4})/);
      const tahun = yearMatch ? parseInt(yearMatch[1]) : now.getFullYear();
      return { bulan: num, tahun };
    }
  }
  // Jika hanya angka bulan
  const numMatch = lower.match(/(\d{1,2})/);
  if (numMatch) {
    const b = parseInt(numMatch[1]);
    if (b >= 1 && b <= 12) return { bulan: b, tahun: now.getFullYear() };
  }
  return { bulan: now.getMonth() + 1, tahun: now.getFullYear() };
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
4. "rekap_bulanan" -> Jika pengguna meminta rekap, laporan bulanan, atau rangkuman keuangan per bulan (contoh: "rekap pengeluaran", "laporan keuangan bulan ini", "rekap agustus", "laporan bulan juli").
5. "tanya" -> Jika pengguna bertanya tentang data keuangan spesifik, detail transaksi tertentu, atau informasi yang bukan rekap bulanan.
6. "chat" -> Jika pesan hanya sapaan atau obrolan biasa yang tidak berhubungan dengan transaksi keuangan.

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

D. Jika action = "rekap_bulanan":
   - 'bulan': nama bulan dan tahun yang diminta (misal: "Agustus 2026"). Jika pengguna tidak menyebutkan bulan spesifik, gunakan bulan saat ini.
   - 'is_transaction': false

E. Jika action = "tanya":
   - 'pertanyaan': isi pertanyaan pengguna.

F. Jika action = "chat":
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
      await sock.sendMessage(from, { text: "Mau ngapain? Contoh:\n- *Catat*: >asisten beli mie gacoan 15rb cash\n- *Edit*: >asisten eh salah tadi harusnya 20rb\n- *Koreksi*: >asisten update saldo cash pemasukan 300rb\n- *Rekap*: >asisten rekap bulan ini\n- *Tanya*: >asisten berapa total pengeluaran hari ini?\n- *Chat*: >asisten halo selamat malam" }, { quoted: msg });
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

      // ===== AKSI 4: REKAP BULANAN =====
      } else if (data.action === "rekap_bulanan") {
        const doc = await getDoc(sheetId);
        const sheetTransaksi = doc.sheetsByTitle['transaksi'] || doc.sheetsByIndex[0];
        const sheetKeuangan = doc.sheetsByTitle['keuangan'];
        const sheetLaporan = doc.sheetsByTitle['laporan_bulanan'];

        // Parse bulan yang diminta
        const requested = parseBulanRequest(data.bulan);
        const bulanLabel = `${BULAN_LABEL[requested.bulan]} ${requested.tahun}`;

        // Filter transaksi berdasarkan bulan
        const allRows = await sheetTransaksi.getRows();
        const filtered = allRows.filter(row => {
          const parsed = parseTimestampMonth(row.get('Timestamp'));
          return parsed && parsed.bulan === requested.bulan && parsed.tahun === requested.tahun;
        });

        // Hitung total pemasukan & pengeluaran
        let totalPemasukan = 0;
        let totalPengeluaran = 0;
        const kategoriMap = {};

        filtered.forEach(row => {
          const nominal = Number(row.get('Nominal')) || 0;
          const tipe = (row.get('Tipe') || '').toLowerCase();
          const kategori = row.get('Kategori') || 'lainnya';

          if (tipe === 'pemasukan') {
            totalPemasukan += nominal;
          } else if (tipe === 'pengeluaran') {
            totalPengeluaran += nominal;
            kategoriMap[kategori] = (kategoriMap[kategori] || 0) + nominal;
          }
        });

        const sisaCashflow = totalPemasukan - totalPengeluaran;
        const tandaPlusMinus = sisaCashflow >= 0 ? '+' : '-';

        // Breakdown pengeluaran per kategori
        let kategoriText = '';
        const sortedKategori = Object.entries(kategoriMap).sort((a, b) => b[1] - a[1]);
        if (sortedKategori.length === 0) {
          kategoriText = '• (Belum ada data pengeluaran)';
        } else {
          kategoriText = sortedKategori.map(([kat, nom]) => {
            const persen = totalPengeluaran > 0 ? ((nom / totalPengeluaran) * 100).toFixed(1) : '0.0';
            return `• ${kat} : ${formatRupiah(nom)} (${persen}%)`;
          }).join('\n');
        }

        // Ambil posisi saldo dompet dari sheet keuangan
        let saldoText = '';
        if (sheetKeuangan) {
          const keuanganRows = await sheetKeuangan.getRows();
          if (keuanganRows.length > 0) {
            saldoText = keuanganRows.map(row => {
              const sumber = row.get('sumber') || row.get('Sumber') || '-';
              const saldo = Number(row.get('total saldo tersedia') || row.get('Total_Saldo_Tersedia') || row.get('saldo') || 0);
              return `• ${sumber} : ${formatRupiah(saldo)}`;
            }).join('\n');
          }
        }
        if (!saldoText) saldoText = '• (Sheet keuangan belum tersedia)';

        // Simpan / Update ke sheet laporan_bulanan
        let statusMessage = '';
        if (sheetLaporan) {
          const laporanRows = await sheetLaporan.getRows();
          const existingRow = laporanRows.find(row => row.get('Bulan') === bulanLabel);
          const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

          if (existingRow) {
            existingRow.set('Pemasukan', totalPemasukan);
            existingRow.set('Pengeluaran', totalPengeluaran);
            existingRow.set('Cashflow', sisaCashflow);
            existingRow.set('Terakhir_Diperbarui', timestamp);
            await existingRow.save();
            statusMessage = `Data laporan bulan ${bulanLabel} di update`;
          } else {
            await sheetLaporan.addRow({
              Bulan: bulanLabel,
              Pemasukan: totalPemasukan,
              Pengeluaran: totalPengeluaran,
              Cashflow: sisaCashflow,
              Terakhir_Diperbarui: timestamp
            });
            statusMessage = `Data laporan ${bulanLabel} berhasil di simpan`;
          }
        } else {
          statusMessage = 'Sheet laporan_bulanan belum tersedia, data tidak disimpan';
        }

        // Kirim balasan
        const reply = `📊 *LAPORAN KEUANGAN - ${bulanLabel.toUpperCase()}*\n\n` +
          `💰 Total Pemasukan  : ${formatRupiah(totalPemasukan)}\n` +
          `💸 Total Pengeluaran : ${formatRupiah(totalPengeluaran)}\n` +
          `📈 Sisa Cashflow     : ${tandaPlusMinus}${formatRupiah(Math.abs(sisaCashflow))}\n\n` +
          `🛍️ *Pengeluaran per Kategori:*\n${kategoriText}\n\n` +
          `💳 *Posisi Saldo Dompet:*\n${saldoText}\n\n` +
          `_${statusMessage}_`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 5: TANYA LAPORAN =====
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
