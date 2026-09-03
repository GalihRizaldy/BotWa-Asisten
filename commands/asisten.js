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

function parseSheetDate(timestampString) {
  if (!timestampString) return null;
  const str = String(timestampString).trim();
  const [datePart] = str.split(/[,\s]+/); 
  if (!datePart) return null;
  
  // Pisahkan DD/MM/YYYY
  const parts = datePart.split('/');
  if (parts.length === 3) {
    return {
      day: parseInt(parts[0], 10),
      month: parseInt(parts[1], 10),
      year: parseInt(parts[2], 10)
    };
  }
  
  // Fallback untuk ISO date (YYYY-MM-DD)
  const isoParts = datePart.split('-');
  if (isoParts.length === 3) {
    return {
      day: parseInt(isoParts[2], 10),
      month: parseInt(isoParts[1], 10),
      year: parseInt(isoParts[0], 10)
    };
  }
  
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

// Helper: Bersihkan string angka dari format mata uang Rupiah
function parseRupiah(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return val;
  // Hapus "Rp", tanda titik, spasi, dan karakter non-angka kecuali minus (-)
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

// Helper: Mapping Dompet
const WALLET_MAP = {
  'cs01': 'cash',
  'dn01': 'dana',
  'sp01': 'shopeepay',
  'bj01': 'bank jago',
  'vc01': 'visa card',
  'rd01': 'rdn saham',
  'pl01': 'paylatter',
  'sb01': 'seabank'
};

function getWalletName(input) {
  if (!input) return "cash";
  const str = input.toLowerCase().trim();
  if (WALLET_MAP[str]) return WALLET_MAP[str];
  return str;
}

function getWalletCode(input) {
  if (!input) return "CS01";
  const str = input.toLowerCase().trim();
  for (const [code, name] of Object.entries(WALLET_MAP)) {
    if (name === str || code === str) return code.toUpperCase();
  }
  return "CS01";
}

// Helper: Undo efek pinjaman jika dibatalkan
async function undoPinjamanRecord(doc, kategori, keterangan, nominal) {
  if (!kategori || !keterangan) return;
  const lowerKat = kategori.toLowerCase();
  
  if (lowerKat !== 'piutang' && lowerKat !== 'pinjaman' && lowerKat !== 'bayar_pinjaman') return;

  const sheetPinjaman = doc.sheetsByTitle['pinjaman'] || doc.sheetsByTitle['Pinjaman'];
  if (!sheetPinjaman) return;

  await sheetPinjaman.loadHeaderRow();
  const rows = await sheetPinjaman.getRows();
  let foundRow = null;
  
  for (let i = 0; i < rows.length; i++) {
    const rowNama = (rows[i].get('nama') || rows[i].get('Nama') || '').toLowerCase();
    // Cari apakah nama di sheet pinjaman disebut di dalam keterangan transaksi
    if (rowNama && keterangan.toLowerCase().includes(rowNama)) {
      foundRow = rows[i];
      break;
    }
  }

  if (!foundRow) return;

  const pinjamanLama = parseRupiah(foundRow.get('pinjaman') || foundRow.get('Pinjaman') || '0');
  const pembayaranLama = parseRupiah(foundRow.get('pembayaran') || foundRow.get('Pembayaran') || '0');
  const sisaLama = parseRupiah(foundRow.get('sisa') || foundRow.get('Sisa') || '0');

  let pinjamanBaru = pinjamanLama;
  let pembayaranBaru = pembayaranLama;
  let sisaBaru = sisaLama;

  if (lowerKat === 'piutang' || lowerKat === 'pinjaman') {
    // Batal utangin (kembalikan pinjaman)
    pinjamanBaru = pinjamanLama - nominal;
    sisaBaru = sisaLama - nominal;
  } else if (lowerKat === 'bayar_pinjaman') {
    // Batal bayar (kembalikan sisa jadi berutang lagi)
    pembayaranBaru = pembayaranLama - nominal;
    sisaBaru = sisaLama + nominal;
  }

  const status = (sisaBaru <= 0) ? 'LUNAS' : 'BELUM LUNAS';

  if (foundRow.get('pinjaman') !== undefined) foundRow.set('pinjaman', Math.max(0, pinjamanBaru));
  else if (foundRow.get('Pinjaman') !== undefined) foundRow.set('Pinjaman', Math.max(0, pinjamanBaru));

  if (foundRow.get('pembayaran') !== undefined) foundRow.set('pembayaran', Math.max(0, pembayaranBaru));
  else if (foundRow.get('Pembayaran') !== undefined) foundRow.set('Pembayaran', Math.max(0, pembayaranBaru));

  if (foundRow.get('sisa') !== undefined) foundRow.set('sisa', Math.max(0, sisaBaru));
  else if (foundRow.get('Sisa') !== undefined) foundRow.set('Sisa', Math.max(0, sisaBaru));

  if (foundRow.get('status') !== undefined) foundRow.set('status', status);
  else if (foundRow.get('Status') !== undefined) foundRow.set('Status', status);
  else if (foundRow.get('keterangan') !== undefined) foundRow.set('keterangan', status);
  else if (foundRow.get('Keterangan') !== undefined) foundRow.set('Keterangan', status);

  await foundRow.save();
}


// Helper: Generate ID Transaksi (TRX-XXXX)
async function generateTrxId(sheet) {
  const rows = await sheet.getRows();
  let maxId = 0;
  for (let i = 0; i < rows.length; i++) {
    const idVal = rows[i].get('id_transaksi');
    if (idVal && idVal.startsWith('TRX-')) {
      const parts = idVal.split('-');
      if (parts.length >= 2) {
        // Ambil angkanya saja, abaikan suffix seperti -A atau -B
        const numPart = parts[1].replace(/[^0-9]/g, '');
        const num = parseInt(numPart, 10);
        if (!isNaN(num) && num > maxId) {
          maxId = num;
        }
      }
    }
  }
  const nextNum = maxId + 1;
  return `TRX-${String(nextNum).padStart(4, '0')}`;
}

// Helper: Generate ID Langganan (SUB-XXX)
async function generateSubId(sheet) {
  const rows = await sheet.getRows();
  let maxId = 0;
  for (let i = 0; i < rows.length; i++) {
    const idVal = rows[i].get('id_langganan') || rows[i]._rawData[0];
    if (idVal && idVal.startsWith('SUB-')) {
      const numPart = idVal.replace('SUB-', '').replace(/[^0-9]/g, '');
      const num = parseInt(numPart, 10);
      if (!isNaN(num) && num > maxId) {
        maxId = num;
      }
    }
  }
  const nextNum = maxId + 1;
  return `SUB-${String(nextNum).padStart(3, '0')}`;
}

// System Prompt untuk ekstraksi JSON (dari instruksi user)
const EXTRACTION_PROMPT = `Kamu adalah asisten pengekstrak data transaksi keuangan. Tugasmu adalah menganalisis pesan pengguna dan mengembalikan output JSON dengan struktur yang ditentukan.

Kategori 'action' yang tersedia:
1. "catat_transaksi" -> Untuk pencatatan pengeluaran atau pemasukan baru biasa. Termasuk memberi pinjaman.
2. "edit_transaksi_terakhir" -> Jika pengguna ingin mengubah/mengoreksi transaksi yang baru saja dikirim sebelumnya.
3. "koreksi_saldo" -> Jika pengguna ingin menyesuaikan/set ulang total saldo atau total pemasukan/pengeluaran untuk sumber tertentu.
4. "rekap_bulanan" -> Jika pengguna meminta rekap, laporan bulanan, atau rangkuman keuangan per bulan.
5. "cek_pinjaman" -> Jika pengguna ingin mengecek status pinjaman, utang, atau piutang.
6. "bayar_pinjaman" -> Jika pengguna menerima pembayaran utang atau membayar piutang (contoh: "ali bayar utang 10k pake cash", "terima bayar pinjaman alwi 30rb").
7. "batal_transaksi" -> Jika pengguna mengirim perintah pembatalan atau penghapusan transaksi terakhir (contoh: "batal", "undo").
8. "tambah_langganan" -> Jika pengguna mendaftarkan langganan atau tagihan rutin baru.
9. "cek_langganan" -> Jika pengguna menanyakan daftar langganan atau tagihan rutin.
10. "bayar_langganan" -> Jika pengguna membayar tagihan langganan yang sudah terdaftar.
11. "hapus_langganan" -> Jika pengguna ingin menonaktifkan atau menghapus langganan.
12. "transfer" -> Jika pengguna mengirim perintah mutasi/transfer uang dari satu dompet ke dompet lain.
13. "cek_saldo_dompet" -> Jika pengguna hanya menanyakan saldo salah satu dompet/rekening (contoh: "cek saldo dana", "sisa cash berapa?", "saldo mandiri ku berapa").
14. "hapus_transaksi_id" -> Jika pengguna mengirim perintah hapus transaksi spesifik berdasarkan ID-nya (contoh: "hapus transaksi TRX-0001", "delete TRX-0001").
15. "tanya" -> Jika pengguna bertanya tentang data keuangan spesifik.
16. "tambah_pinjaman" -> Jika pengguna memberikan pinjaman/utang ke orang lain (contoh: "renggi utang 10k", "pinjemin uang ke ali 50rb").
17. "chat" -> Jika pesan hanya sapaan atau obrolan biasa.

Aturan Ekstraksi JSON:

A. Jika action = "catat_transaksi":
   - 'tipe': "pemasukan" atau "pengeluaran"
   - 'kategori': nama kategori. (Catatan: JANGAN gunakan ini jika pengguna memberi pinjaman, gunakan "tambah_pinjaman" saja)
   - 'keterangan': deskripsi singkat transaksi
   - 'nominal': angka (integer)
   - 'sumber': nama dompet/sumber uang (atau kode dompet) dalam huruf kecil. Default "cash".

B. Jika action = "transfer":
   - 'is_transaction': true
   - 'nominal': angka uang yang ditarik/keluar dari asal
   - 'sumber_asal': sumber pengeluaran (huruf kecil)
   - 'sumber_tujuan': sumber pemasukan (huruf kecil)
   - 'keterangan': deskripsi singkat
   - 'nominal_tujuan': (opsional) angka uang yang diterima. Isi jika nominal yang masuk berbeda/ada untung/biaya admin. Jika sama, kosongi saja.

C. Jika action = "hapus_transaksi_id":
   - 'target_id': ID transaksi yang ingin dihapus (contoh: "TRX-0001")

D. Jika action = "edit_transaksi_terakhir":
   - Extract field yang diubah oleh pengguna. Tambahkan field 'is_edit': true.

E. Jika action = "koreksi_saldo":
   - 'sumber', 'nominal_pemasukan', 'nominal_pengeluaran', 'keterangan': "Penyesuaian saldo".

F. Jika action = "rekap_bulanan":
   - 'bulan', 'is_transaction': false
   - 'periode': "harian" | "mingguan" | "bulanan". (Jika pengguna meminta hari ini -> "harian", minggu ini -> "mingguan", bulan ini -> "bulanan")

G. Jika action = "tambah_langganan":
   - 'nama_layanan', 'nominal', 'frekuensi', 'tanggal_jatuh_tempo', 'sumber_default', 'kategori', 'status'.

H. Jika action = "bayar_pinjaman":
   - 'nama': nama orang yang berutang/dibayar
   - 'nominal': angka (integer)
   - 'sumber': nama dompet tujuan pembayaran (huruf kecil)

I. Jika action = "tambah_pinjaman":
   - 'nama': nama orang yang berutang
   - 'nominal': angka (integer)
   - 'sumber': nama dompet sumber dana dikeluarkan (huruf kecil)
   - 'keterangan': opsional deskripsi

J. Jika action = "cek_saldo_dompet":
   - 'sumber': ekstrak nama dompetnya dalam huruf kecil (misal: dana, cash, seabank).
   - 'is_transaction': false

J. Jika action = "cek_pinjaman", "batal_transaksi", "cek_langganan", "bayar_langganan", "hapus_langganan":
   - Ikuti properti yang sama seperti aturan sebelumnya (tambahkan 'is_transaction': false jika relevan). Untuk 'bayar_langganan', butuh 'nama_layanan' atau target ID.

K. Jika action = "tanya":
   - 'pertanyaan': isi pertanyaan pengguna.

L. Jika action = "chat":
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
      await sock.sendMessage(from, { text: "Mau ngapain? Contoh:\n- *Catat*: >asisten beli mie gacoan 15rb cash\n- *Batal*: >asisten batal\n- *Edit*: >asisten eh salah tadi harusnya 20rb\n- *Koreksi*: >asisten update saldo cash pemasukan 300rb\n- *Rekap*: >asisten rekap bulan ini\n- *Pinjaman*: >asisten cek utang galih\n- *Langganan*: >asisten tambah langganan wifi 350rb tgl 20\n- *Bayar*: >asisten bayar wifi indihome\n- *Tanya*: >asisten berapa total pengeluaran hari ini?\n- *Chat*: >asisten halo selamat malam" }, { quoted: msg });
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
        await sheet.loadHeaderRow(); // Refresh cache header
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const idTrx = await generateTrxId(sheet);
        const dompetKode = getWalletCode(data.sumber);
        const dompetNama = getWalletName(data.sumber);

        await sheet.addRow({
          id_transaksi: idTrx,
          timestamp: timestamp,
          wa_id: waId.split('@')[0],
          tipe: (data.tipe || '').toLowerCase(),
          kategori: (data.kategori || '').toLowerCase(),
          keterangan: data.keterangan,
          nominal: data.nominal,
          sumber: dompetNama.toLowerCase()
        });

        const emoji = data.tipe === 'pemasukan' ? '💰' : '💸';
        const reply = `${emoji} *Tercatat!*\n\n` +
          `• ID       : ${idTrx}\n` +
          `• ${data.tipe.toUpperCase()}: ${data.keterangan}\n` +
          `• Nominal  : ${formatRupiah(data.nominal)}\n` +
          `• Kategori : ${data.kategori}\n` +
          `• Sumber   : ${dompetKode} ${dompetNama.toUpperCase()}\n\n` +
          `_Sudah masuk ke Spreadsheet._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI BARU: TRANSFER =====
      } else if (data.action === "transfer") {
        const sheet = await getSheet(sheetId, 'transaksi');
        await sheet.loadHeaderRow(); // Refresh cache header
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        
        const baseId = await generateTrxId(sheet);
        const idOut = `${baseId}-A`;
        const idIn = `${baseId}-B`;
        
        const asalKode = getWalletCode(data.sumber_asal);
        const asalNama = getWalletName(data.sumber_asal).toLowerCase();
        const tujuanKode = getWalletCode(data.sumber_tujuan);
        const tujuanNama = getWalletName(data.sumber_tujuan).toLowerCase();
        
        const nominalKeluar = data.nominal;
        const nominalMasuk = data.nominal_tujuan || data.nominal;
        
        // Catat Pengeluaran
        await sheet.addRow({
          id_transaksi: idOut,
          timestamp: timestamp,
          wa_id: waId.split('@')[0],
          tipe: "pengeluaran",
          kategori: "transfer",
          keterangan: data.keterangan || `Transfer ke ${tujuanNama}`,
          nominal: nominalKeluar,
          sumber: asalNama
        });
        
        // Catat Pemasukan
        await sheet.addRow({
          id_transaksi: idIn,
          timestamp: timestamp,
          wa_id: waId.split('@')[0],
          tipe: "pemasukan",
          kategori: "transfer",
          keterangan: data.keterangan || `Terima transfer dari ${asalNama}`,
          nominal: nominalMasuk,
          sumber: tujuanNama
        });
        
        let nominalText = `• Nominal   : ${formatRupiah(nominalKeluar)}`;
        if (nominalKeluar !== nominalMasuk) {
          nominalText = `• Nominal Keluar : ${formatRupiah(nominalKeluar)}\n` +
                        `• Nominal Masuk  : ${formatRupiah(nominalMasuk)} (Selisih: ${formatRupiah(nominalMasuk - nominalKeluar)})`;
        }

        const reply = `🔄 *TRANSFER SALDO BERHASIL*\n\n` +
          `• ID Keluar : ${idOut} (${asalKode} ${asalNama.toUpperCase()})\n` +
          `• ID Masuk  : ${idIn} (${tujuanKode} ${tujuanNama.toUpperCase()})\n` +
          `${nominalText}\n\n` +
          `_Mutasi selesai dicatat ke Spreadsheet._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI BARU: HAPUS BY ID =====
      // ===== AKSI BARU: HAPUS BY ID =====
      } else if (data.action === "hapus_transaksi_id") {
        const doc = await getDoc(sheetId);
        const sheet = doc.sheetsByTitle['transaksi'] || doc.sheetsByIndex[0];
        await sheet.loadHeaderRow();
        const rows = await sheet.getRows();
        const targetId = (data.target_id || '').toUpperCase().trim();
        
        let foundRow = null;
        for (let i = 0; i < rows.length; i++) {
          const rowId = rows[i].get('id_transaksi') || rows[i]._rawData[0];
          if ((rowId || '').toUpperCase() === targetId) {
            foundRow = rows[i];
            break;
          }
        }
        
        if (!foundRow) {
          await sock.sendMessage(from, { text: `⚠️ Transaksi dengan ID *${targetId}* tidak ditemukan.` }, { quoted: msg });
          return;
        }
        
        const idTrx = foundRow.get('id_transaksi') || foundRow._rawData[0] || '-';
        const tipeTrx = foundRow.get('tipe') || foundRow._rawData[3] || '-';
        const kategoriTrx = foundRow.get('kategori') || foundRow._rawData[4] || '';
        const keteranganTrx = foundRow.get('keterangan') || foundRow._rawData[5] || '';
        const nominalTrx = parseRupiah(foundRow.get('nominal') || foundRow._rawData[6] || '0');
        const sumberTrx = foundRow.get('sumber') || foundRow._rawData[7] || '-';
        
        await undoPinjamanRecord(doc, kategoriTrx, keteranganTrx, nominalTrx);
        
        await foundRow.delete();
        
        let extraReply = '';
        if (kategoriTrx.toLowerCase() === 'piutang' || kategoriTrx.toLowerCase() === 'pinjaman' || kategoriTrx.toLowerCase() === 'bayar_pinjaman') {
          extraReply = `\n_Data saldo pinjaman juga telah otomatis disesuaikan._`;
        }

        const reply = `🗑️ *TRANSAKSI BERHASIL DIHAPUS*\n\n` +
          `• ID       : ${idTrx}\n` +
          `• Tipe     : ${tipeTrx.toUpperCase()}\n` +
          `• Nominal  : Rp ${Math.abs(nominalTrx).toLocaleString('id-ID')}\n` +
          `• Sumber   : ${sumberTrx}\n\n` +
          `_Data telah dihapus secara permanen._${extraReply}`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 2: BATALKAN TRANSAKSI TERAKHIR =====
      } else if (data.action === "batal_transaksi") {
        const doc = await getDoc(sheetId);
        const sheet = doc.sheetsByTitle['transaksi'] || doc.sheetsByIndex[0];
        await sheet.loadHeaderRow();
        const rows = await sheet.getRows();
        const userId = waId.split('@')[0];

        // Cari transaksi terakhir milik user ini
        let lastRow = null;
        for (let i = rows.length - 1; i >= 0; i--) {
          const rowWaId = rows[i].get('wa_id') || rows[i]._rawData[2];
          if (rowWaId === userId) {
            lastRow = rows[i];
            break;
          }
        }

        if (!lastRow) {
          await sock.sendMessage(from, { text: "⚠️ Tidak ada riwayat transaksi yang bisa dibatalkan." }, { quoted: msg });
          return;
        }

        const idTrx = lastRow.get('id_transaksi') || lastRow._rawData[0] || '-';
        const tipeTrx = lastRow.get('tipe') || lastRow._rawData[3] || '-';
        const kategoriTrx = lastRow.get('kategori') || lastRow._rawData[4] || '';
        const keteranganTrx = lastRow.get('keterangan') || lastRow._rawData[5] || '';
        const nominalTrx = parseRupiah(lastRow.get('nominal') || lastRow._rawData[6] || '0');
        const sumberTrx = lastRow.get('sumber') || lastRow._rawData[7] || '-';

        await undoPinjamanRecord(doc, kategoriTrx, keteranganTrx, nominalTrx);

        await lastRow.delete();

        let extraReply = '';
        if (kategoriTrx.toLowerCase() === 'piutang' || kategoriTrx.toLowerCase() === 'pinjaman' || kategoriTrx.toLowerCase() === 'bayar_pinjaman') {
          extraReply = `\n_Data saldo pinjaman juga telah otomatis disesuaikan._`;
        }

        const reply = `🗑️ *TRANSAKSI BERHASIL DIHAPUS*\n\n` +
          `• ID       : ${idTrx}\n` +
          `• Tipe     : ${tipeTrx.toUpperCase()}\n` +
          `• Nominal  : Rp ${Math.abs(nominalTrx).toLocaleString('id-ID')}\n` +
          `• Sumber   : ${sumberTrx}\n\n` +
          `_Data telah dihapus secara permanen._${extraReply}`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 3: EDIT TRANSAKSI TERAKHIR =====
      } else if (data.action === "edit_transaksi_terakhir") {
        const sheet = await getSheet(sheetId, 'transaksi');
        await sheet.loadHeaderRow();
        const rows = await sheet.getRows();
        const userId = waId.split('@')[0];

        // Cari transaksi terakhir milik user ini
        let lastRow = null;
        for (let i = rows.length - 1; i >= 0; i--) {
          const rowWaId = rows[i].get('wa_id') || rows[i]._rawData[2];
          if (rowWaId === userId) {
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
          tipe: lastRow.get('tipe') || lastRow._rawData[3],
          kategori: lastRow.get('kategori') || lastRow._rawData[4],
          keterangan: lastRow.get('keterangan') || lastRow._rawData[5],
          nominal: parseRupiah(lastRow.get('nominal') || lastRow._rawData[6]),
          sumber: lastRow.get('sumber') || lastRow._rawData[7]
        };

        // Update hanya field yang diubah (non-null)
        if (data.tipe) lastRow.set('tipe', data.tipe.toLowerCase());
        if (data.kategori) lastRow.set('kategori', data.kategori.toLowerCase());
        if (data.keterangan) lastRow.set('keterangan', data.keterangan);
        if (data.nominal) lastRow.set('nominal', data.nominal);
        if (data.sumber) lastRow.set('sumber', data.sumber.toLowerCase());

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
        await sheet.loadHeaderRow();
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const sumber = (data.sumber || "cash").toLowerCase();

        // Hitung total saat ini untuk sumber tersebut
        const rows = await sheet.getRows();
        let totalPemasukan = 0;
        let totalPengeluaran = 0;
        rows.forEach(row => {
          const rowSumber = row.get('sumber') || row._rawData[7];
          if (rowSumber?.toLowerCase() === sumber) {
            const nominal = parseRupiah(row.get('nominal') || row._rawData[6]);
            const tipe = row.get('tipe') || row._rawData[3];
            if (tipe?.toLowerCase() === 'pemasukan') totalPemasukan += nominal;
            if (tipe?.toLowerCase() === 'pengeluaran') totalPengeluaran += nominal;
          }
        });

        // Tambahkan baris koreksi jika ada selisih
        let koreksiDone = [];

        if (data.nominal_pemasukan !== undefined && data.nominal_pemasukan !== null) {
          const selisihMasuk = data.nominal_pemasukan - totalPemasukan;
          if (selisihMasuk !== 0) {
            const idTrx = await generateTrxId(sheet);
            await sheet.addRow({
              id_transaksi: idTrx,
              timestamp: timestamp,
              wa_id: waId.split('@')[0],
              tipe: selisihMasuk >= 0 ? "pemasukan" : "pengeluaran",
              kategori: "koreksi",
              keterangan: `Koreksi saldo pemasukan ${sumber} (${formatRupiah(totalPemasukan)} → ${formatRupiah(data.nominal_pemasukan)})`,
              nominal: Math.abs(selisihMasuk),
              sumber: sumber
            });
            koreksiDone.push(`Pemasukan ${sumber}: ${formatRupiah(totalPemasukan)} → ${formatRupiah(data.nominal_pemasukan)}`);
          }
        }

        if (data.nominal_pengeluaran !== undefined && data.nominal_pengeluaran !== null) {
          const selisihKeluar = data.nominal_pengeluaran - totalPengeluaran;
          if (selisihKeluar !== 0) {
            const idTrx = await generateTrxId(sheet);
            await sheet.addRow({
              id_transaksi: idTrx,
              timestamp: timestamp,
              wa_id: waId.split('@')[0],
              tipe: selisihKeluar >= 0 ? "pengeluaran" : "pemasukan",
              kategori: "koreksi",
              keterangan: `Koreksi saldo pengeluaran ${sumber} (${formatRupiah(totalPengeluaran)} → ${formatRupiah(data.nominal_pengeluaran)})`,
              nominal: Math.abs(selisihKeluar),
              sumber: sumber
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

      // ===== AKSI BARU: CEK SALDO DOMPET =====
      } else if (data.action === "cek_saldo_dompet") {
        const sheet = await getSheet(sheetId, 'keuangan');
        await sheet.loadHeaderRow();
        const rows = await sheet.getRows();
        const sumberTarget = (data.sumber || '').toLowerCase().trim();
        
        const walletName = getWalletName(sumberTarget).toLowerCase();
        const walletCode = getWalletCode(sumberTarget).toLowerCase();

        let foundRow = null;
        for (let i = 0; i < rows.length; i++) {
          const s = (rows[i].get('sumber') || rows[i]._rawData[1] || '').toLowerCase();
          const c = (rows[i].get('kode') || rows[i]._rawData[0] || '').toLowerCase();
          if (s.includes(sumberTarget) || s.includes(walletName) || c === walletCode) {
            foundRow = rows[i];
            break;
          }
        }

        if (!foundRow) {
          await sock.sendMessage(from, { text: `⚠️ Dompet '${data.sumber || 'tersebut'}' tidak ditemukan di catatan keuangan.` }, { quoted: msg });
          return;
        }

        const saldo = parseRupiah(foundRow.get('total_saldo_tersedia') || foundRow.get('total saldo tersedia') || foundRow._rawData[2] || '0');
        const namaDompet = foundRow.get('sumber') || foundRow._rawData[1] || data.sumber;
        
        await sock.sendMessage(from, { text: `💳 *Info Saldo*\nSaldo *${namaDompet.toUpperCase()}* Anda saat ini adalah: *${formatRupiah(saldo)}*` }, { quoted: msg });

      // ===== AKSI 4: REKAP BULANAN / HARIAN / MINGGUAN =====
      } else if (data.action === "rekap_bulanan") {
        const doc = await getDoc(sheetId);
        const sheetTransaksi = doc.sheetsByTitle['transaksi'] || doc.sheetsByIndex[0];
        await sheetTransaksi.loadHeaderRow();
        const sheetKeuangan = doc.sheetsByTitle['keuangan'];
        
        const periode = (data.periode || 'bulanan').toLowerCase();
        const allRows = await sheetTransaksi.getRows();
        let filtered = [];
        let labelLaporan = '';
        let isBulanan = (periode === 'bulanan');
        let bulanLabel = '';

        if (isBulanan) {
          const requested = parseBulanRequest(data.bulan);
          bulanLabel = `${BULAN_LABEL[requested.bulan]} ${requested.tahun}`;
          labelLaporan = bulanLabel.toUpperCase();
          filtered = allRows.filter(row => {
            const timestampStr = row.get('timestamp') || row._rawData[1];
            const parsed = parseSheetDate(timestampStr);
            return parsed && parsed.month === requested.bulan && parsed.year === requested.tahun;
          });
        } else {
          const now = new Date();
          const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          let startOfPeriode = new Date(startOfToday);
          
          if (periode === 'mingguan') {
             const day = startOfToday.getDay(); 
             const diff = startOfToday.getDate() - day + (day === 0 ? -6 : 1); // Senin
             startOfPeriode = new Date(now.getFullYear(), now.getMonth(), diff);
          }

          labelLaporan = periode === 'harian' ? 'HARI INI' : 'MINGGU INI';
          filtered = allRows.filter(row => {
            const timestampStr = row.get('timestamp') || row._rawData[1];
            const parsed = parseSheetDate(timestampStr);
            if (!parsed) return false;
            
            if (periode === 'harian') {
              return parsed.year === now.getFullYear() && parsed.month === (now.getMonth() + 1) && parsed.day === now.getDate();
            } else {
              // Mingguan
              const dMidnight = new Date(parsed.year, parsed.month - 1, parsed.day);
              const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
              return dMidnight >= startOfPeriode && dMidnight <= endOfToday;
            }
          });
        }

        // Hitung total pemasukan & pengeluaran
        let totalPemasukan = 0;
        let totalPengeluaran = 0;
        const kategoriMap = {};

        filtered.forEach(row => {
          const nominal = parseRupiah(row.get('nominal') || row._rawData[6] || '0');
          const tipe = (row.get('tipe') || row._rawData[3] || '').toLowerCase();
          const kategori = (row.get('kategori') || row._rawData[4] || 'lainnya').toLowerCase();

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

        // Ambil posisi saldo dompet
        let saldoText = '';
        if (sheetKeuangan) {
          const keuanganRows = await sheetKeuangan.getRows();
          if (keuanganRows.length > 0) {
            const validRows = keuanganRows.filter(row => {
              const sumber = row.get('sumber') || row.get('Sumber') || '';
              return sumber && sumber.trim() !== '' && sumber.trim() !== '-';
            });
            if (validRows.length > 0) {
              saldoText = validRows.map(row => {
                const sumber = row.get('sumber') || row.get('Sumber') || '-';
                const rawSaldo = row.get('total_saldo_tersedia') || row.get('total saldo tersedia') || row._rawData[2] || '0';
                const nominalSaldo = parseRupiah(rawSaldo);
                const formattedSaldo = (nominalSaldo < 0 ? '-' : '') + formatRupiah(Math.abs(nominalSaldo));
                return `• ${sumber} : ${formattedSaldo}`;
              }).join('\n');
            }
          }
        }
        if (!saldoText) saldoText = '• (Sheet keuangan belum tersedia)';

        // Simpan hanya jika bulanan
        let statusMessage = '';
        if (isBulanan) {
          const sheetLaporan = doc.sheetsByTitle['laporan_bulanan'];
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
              statusMessage = `_Data laporan bulan ${bulanLabel} di update_`;
            } else {
              await sheetLaporan.addRow({
                Bulan: bulanLabel,
                Pemasukan: totalPemasukan,
                Pengeluaran: totalPengeluaran,
                Cashflow: sisaCashflow,
                Terakhir_Diperbarui: timestamp
              });
              statusMessage = `_Data laporan ${bulanLabel} berhasil di simpan_`;
            }
          } else {
            statusMessage = '_Sheet laporan_bulanan belum tersedia, data tidak disimpan_';
          }
        } else {
          statusMessage = '_Laporan di-generate on-the-fly (tidak disimpan ke sheet bulanan)_';
        }

        const reply = `📊 *LAPORAN KEUANGAN - ${labelLaporan}*\n\n` +
          `💰 Total Pemasukan  : ${formatRupiah(totalPemasukan)}\n` +
          `💸 Total Pengeluaran : ${formatRupiah(totalPengeluaran)}\n` +
          `📈 Sisa Cashflow     : ${tandaPlusMinus}${formatRupiah(Math.abs(sisaCashflow))}\n\n` +
          `🛍️ *Pengeluaran per Kategori:*\n${kategoriText}\n\n` +
          `💳 *Posisi Saldo Dompet:*\n${saldoText}\n\n` +
          `${statusMessage}`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 5: CEK PINJAMAN =====
      } else if (data.action === "cek_pinjaman") {
        const doc = await getDoc(sheetId);
        const sheetPinjaman = doc.sheetsByTitle['pinjaman'] || doc.sheetsByTitle['Pinjaman'];
        
        if (!sheetPinjaman) {
          await sock.sendMessage(from, { text: "Sheet 'pinjaman' belum tersedia." }, { quoted: msg });
          return;
        }

        const rows = await sheetPinjaman.getRows();
        const validRows = rows.filter(row => {
          const nama = row.get('nama') || row.get('Nama');
          return nama && nama.trim() !== '';
        });

        if (validRows.length === 0) {
          await sock.sendMessage(from, { text: "Belum ada data pinjaman." }, { quoted: msg });
          return;
        }

        let replyText = "📋 *STATUS PINJAMAN & PIUTANG*\n";
        
        validRows.forEach(row => {
          const nama = row.get('nama') || row.get('Nama');
          const pinjaman = row.get('pinjaman') || row.get('Pinjaman') || '0';
          const pembayaran = row.get('pembayaran') || row.get('Pembayaran') || '0';
          const sisa = row.get('sisa') || row.get('Sisa') || '0';
          const status = row.get('status') || row.get('keterangan') || row.get('Status') || row.get('Keterangan') || '-';

          replyText += `\n• *${nama}*\n` +
            `  - Total Pinjaman : ${formatRupiah(pinjaman)}\n` +
            `  - Sudah Dibayar  : ${formatRupiah(pembayaran)}\n` +
            `  - Sisa Piutang   : ${formatRupiah(sisa)}\n` +
            `  - Status         : ${status}\n`;
        });

        await sock.sendMessage(from, { text: replyText }, { quoted: msg });

      // ===== AKSI 5B: BAYAR PINJAMAN =====
      } else if (data.action === "bayar_pinjaman") {
        const doc = await getDoc(sheetId);
        const sheetPinjaman = doc.sheetsByTitle['pinjaman'] || doc.sheetsByTitle['Pinjaman'];
        const sheetTransaksi = doc.sheetsByTitle['transaksi'] || doc.sheetsByIndex[0];

        if (!sheetPinjaman) {
          await sock.sendMessage(from, { text: "Sheet 'pinjaman' belum tersedia." }, { quoted: msg });
          return;
        }

        const rows = await sheetPinjaman.getRows();
        const namaTarget = (data.nama || '').toLowerCase();
        
        let foundRow = null;
        for (let i = 0; i < rows.length; i++) {
          const rowNama = (rows[i].get('nama') || rows[i].get('Nama') || '').toLowerCase();
          if (rowNama && rowNama.includes(namaTarget)) {
            foundRow = rows[i];
            break;
          }
        }

        if (!foundRow) {
          await sock.sendMessage(from, { text: `⚠️ Data pinjaman atas nama *${data.nama}* tidak ditemukan.` }, { quoted: msg });
          return;
        }

        const pinjamanAwal = parseRupiah(foundRow.get('pinjaman') || foundRow.get('Pinjaman') || '0');
        const pembayaranLama = parseRupiah(foundRow.get('pembayaran') || foundRow.get('Pembayaran') || '0');
        
        const totalPembayaranBaru = pembayaranLama + data.nominal;
        const sisaBaru = pinjamanAwal - totalPembayaranBaru;
        const status = (sisaBaru <= 0) ? 'LUNAS' : 'BELUM LUNAS';

        foundRow.set('pembayaran', totalPembayaranBaru);
        foundRow.set('sisa', sisaBaru);
        if (foundRow.get('status') !== undefined) foundRow.set('status', status);
        else if (foundRow.get('Status') !== undefined) foundRow.set('Status', status);
        else if (foundRow.get('keterangan') !== undefined) foundRow.set('keterangan', status);
        else if (foundRow.get('Keterangan') !== undefined) foundRow.set('Keterangan', status);
        else foundRow.set('status', status); // fallback

        await foundRow.save();

        await sheetTransaksi.loadHeaderRow();
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const idTrx = await generateTrxId(sheetTransaksi);
        const dompetKode = getWalletCode(data.sumber);
        const dompetNama = getWalletName(data.sumber).toLowerCase();

        const namaPeminjam = foundRow.get('nama') || foundRow.get('Nama') || data.nama;
        await sheetTransaksi.addRow({
          id_transaksi: idTrx,
          timestamp: timestamp,
          wa_id: waId.split('@')[0],
          tipe: 'pemasukan',
          kategori: 'bayar_pinjaman',
          keterangan: `Bayar Pinjaman: ${namaPeminjam} - ${data.keterangan || ''}`.trim(),
          nominal: data.nominal,
          sumber: dompetNama
        });

        const reply = `💰 *PEMBAYARAN PINJAMAN TERCATAT*\n\n` +
          `• ID TRX       : ${idTrx}\n` +
          `• Nama         : ${foundRow.get('nama') || foundRow.get('Nama') || data.nama}\n` +
          `• Nominal      : Rp ${data.nominal.toLocaleString('id-ID')}\n` +
          `• Masuk ke     : ${dompetKode} ${dompetNama.toUpperCase()}\n` +
          `• Sisa Piutang : Rp ${Math.max(0, sisaBaru).toLocaleString('id-ID')} (${status})\n\n` +
          `_Sudah otomatis tercatat di sheet transaksi dan sheet pinjaman._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI BARU: TAMBAH PINJAMAN =====
      } else if (data.action === "tambah_pinjaman") {
        const doc = await getDoc(sheetId);
        const sheetPinjaman = doc.sheetsByTitle['pinjaman'] || doc.sheetsByTitle['Pinjaman'];
        const sheetTransaksi = doc.sheetsByTitle['transaksi'] || doc.sheetsByIndex[0];

        if (!sheetPinjaman) {
          await sock.sendMessage(from, { text: "Sheet 'pinjaman' belum tersedia." }, { quoted: msg });
          return;
        }

        const namaTarget = (data.nama || 'Tanpa Nama').trim();
        
        // Cek apakah orang ini sudah punya utang (untuk ditambah)
        await sheetPinjaman.loadHeaderRow();
        const rows = await sheetPinjaman.getRows();
        let foundRow = null;
        for (let i = 0; i < rows.length; i++) {
          const rowNama = (rows[i].get('nama') || rows[i].get('Nama') || '').toLowerCase();
          if (rowNama && rowNama === namaTarget.toLowerCase()) {
            foundRow = rows[i];
            break;
          }
        }

        if (foundRow) {
          // Update pinjaman yang sudah ada
          const pinjamanLama = parseRupiah(foundRow.get('pinjaman') || foundRow.get('Pinjaman') || '0');
          const sisaLama = parseRupiah(foundRow.get('sisa') || foundRow.get('Sisa') || '0');
          
          const pinjamanBaru = pinjamanLama + data.nominal;
          const sisaBaru = sisaLama + data.nominal;
          const status = (sisaBaru <= 0) ? 'LUNAS' : 'BELUM LUNAS';

          if (foundRow.get('pinjaman') !== undefined) foundRow.set('pinjaman', pinjamanBaru);
          else if (foundRow.get('Pinjaman') !== undefined) foundRow.set('Pinjaman', pinjamanBaru);
          
          if (foundRow.get('sisa') !== undefined) foundRow.set('sisa', sisaBaru);
          else if (foundRow.get('Sisa') !== undefined) foundRow.set('Sisa', sisaBaru);

          if (foundRow.get('status') !== undefined) foundRow.set('status', status);
          else if (foundRow.get('Status') !== undefined) foundRow.set('Status', status);
          else if (foundRow.get('keterangan') !== undefined) foundRow.set('keterangan', status);
          else if (foundRow.get('Keterangan') !== undefined) foundRow.set('Keterangan', status);
          
          await foundRow.save();
        } else {
          // Buat baris baru
          await sheetPinjaman.addRow({
            nama: namaTarget,
            pinjaman: data.nominal,
            pembayaran: 0,
            sisa: data.nominal,
            status: 'BELUM LUNAS',
            keterangan: 'BELUM LUNAS'
          });
        }

        // Catat sebagai pengeluaran di sheet transaksi
        await sheetTransaksi.loadHeaderRow();
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const idTrx = await generateTrxId(sheetTransaksi);
        const dompetKode = getWalletCode(data.sumber);
        const dompetNama = getWalletName(data.sumber).toLowerCase();

        await sheetTransaksi.addRow({
          id_transaksi: idTrx,
          timestamp: timestamp,
          wa_id: waId.split('@')[0],
          tipe: 'pengeluaran',
          kategori: 'piutang',
          keterangan: `Pinjaman: ${namaTarget} - ${data.keterangan || ''}`.trim(),
          nominal: data.nominal,
          sumber: dompetNama
        });

        const reply = `💸 *PINJAMAN TERCATAT!*\n\n` +
          `• ID TRX       : ${idTrx}\n` +
          `• Nama         : ${namaTarget}\n` +
          `• Tambah Utang : Rp ${data.nominal.toLocaleString('id-ID')}\n` +
          `• Diambil dari : ${dompetKode} ${dompetNama.toUpperCase()}\n\n` +
          `_Sudah otomatis masuk ke sheet transaksi & sheet pinjaman._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 6: TAMBAH LANGGANAN =====
      } else if (data.action === "tambah_langganan") {
        const doc = await getDoc(sheetId);
        let sheetLangganan = doc.sheetsByTitle['langganan'] || doc.sheetsByTitle['Langganan'];

        if (!sheetLangganan) {
          await sock.sendMessage(from, { text: "Sheet 'langganan' belum tersedia. Silakan buat sheet bernama 'langganan' dengan header baris 1 huruf kecil: id_langganan, nama_layanan, nominal, frekuensi, tanggal_jatuh_tempo, sumber_default, kategori, status, ditambahkan." }, { quoted: msg });
          return;
        }

        await sheetLangganan.loadHeaderRow();
        const idSub = await generateSubId(sheetLangganan);
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        
        await sheetLangganan.addRow({
          id_langganan: idSub,
          nama_layanan: data.nama_layanan,
          nominal: data.nominal,
          frekuensi: (data.frekuensi || 'bulanan').toLowerCase(),
          tanggal_jatuh_tempo: data.tanggal_jatuh_tempo,
          sumber_default: (data.sumber_default || 'cash').toLowerCase(),
          kategori: (data.kategori || 'kebutuhan').toLowerCase(),
          status: 'aktif',
          ditambahkan: timestamp
        });

        const freq = (data.frekuensi || 'bulanan').toLowerCase();
        let tempoText = '';
        if (freq.includes('harian')) tempoText = 'Setiap Hari';
        else if (freq.includes('mingguan')) tempoText = `Setiap ${data.tanggal_jatuh_tempo || 'Minggu'}`;
        else if (freq.includes('tahunan')) tempoText = `Setiap Tanggal ${data.tanggal_jatuh_tempo || '-'} per tahun`;
        else tempoText = `Tanggal ${data.tanggal_jatuh_tempo || '-'} setiap bulan`;

        const reply = `📌 *LANGGANAN BERHASIL DITAMBAHKAN*\n\n` +
          `• ID Langganan : ${idSub}\n` +
          `• Layanan      : ${data.nama_layanan}\n` +
          `• Nominal      : ${formatRupiah(data.nominal)}\n` +
          `• Frekuensi    : ${data.frekuensi || 'bulanan'}\n` +
          `• Jatuh Tempo  : ${tempoText}\n` +
          `• Sumber       : ${data.sumber_default || 'cash'}\n` +
          `• Kategori     : ${data.kategori || 'kebutuhan'}\n\n` +
          `_Bot akan mengingatkan Anda saat jatuh tempo._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 7: CEK LANGGANAN =====
      } else if (data.action === "cek_langganan") {
        const doc = await getDoc(sheetId);
        const sheetLangganan = doc.sheetsByTitle['langganan'] || doc.sheetsByTitle['Langganan'];

        if (!sheetLangganan) {
          await sock.sendMessage(from, { text: "Sheet 'langganan' belum tersedia." }, { quoted: msg });
          return;
        }

        const rows = await sheetLangganan.getRows();
        const aktifRows = rows.filter(row => {
          const status = (row.get('status') || row.get('Status') || row._rawData[7] || '').toLowerCase();
          return status === 'aktif';
        });

        if (aktifRows.length === 0) {
          await sock.sendMessage(from, { text: "Belum ada langganan aktif." }, { quoted: msg });
          return;
        }

        let totalBeban = 0;
        let replyText = "📋 *DAFTAR LANGGANAN & TAGIHAN RUTIN*\n";

        aktifRows.forEach(row => {
          const idSub = row.get('id_langganan') || row.get('ID_Langganan') || row._rawData[0] || '-';
          const nama = row.get('nama_layanan') || row.get('Nama_Layanan') || row._rawData[1] || '-';
          const nominal = parseRupiah(row.get('nominal') || row.get('Nominal') || row._rawData[2] || '0');
          const frekuensi = row.get('frekuensi') || row.get('Frekuensi') || row._rawData[3] || 'bulanan';
          const tgl = row.get('tanggal_jatuh_tempo') || row.get('Tanggal_Jatuh_Tempo') || row._rawData[4] || '-';
          const sumber = row.get('sumber_default') || row.get('Sumber_Default') || row._rawData[5] || 'cash';

          const freqLower = (frekuensi || '').toLowerCase();
          if (freqLower.includes('bulanan')) totalBeban += nominal;
          else if (freqLower.includes('harian')) totalBeban += (nominal * 30);
          else if (freqLower.includes('mingguan')) totalBeban += (nominal * 4);
          else if (freqLower.includes('tahunan')) totalBeban += Math.floor(nominal / 12);

          let tempoLabel = '';
          if (freqLower.includes('harian')) tempoLabel = 'Setiap Hari';
          else if (freqLower.includes('mingguan')) tempoLabel = `Tiap ${tgl || 'Minggu'}`;
          else if (freqLower.includes('tahunan')) tempoLabel = `Tgl ${tgl || '-'}`;
          else tempoLabel = `Tgl ${tgl || '-'}`;

          replyText += `\n• *${idSub} | ${nama}* : ${formatRupiah(nominal)} / ${frekuensi}\n` +
            `  - Jatuh Tempo : ${tempoLabel}\n` +
            `  - Sumber      : ${sumber}\n`;
        });

        replyText += `\n💰 *Total Estimasi Beban Bulanan: ${formatRupiah(totalBeban)}*`;

        await sock.sendMessage(from, { text: replyText }, { quoted: msg });

      // ===== AKSI 8: BAYAR LANGGANAN =====
      } else if (data.action === "bayar_langganan") {
        const doc = await getDoc(sheetId);
        const sheetLangganan = doc.sheetsByTitle['langganan'] || doc.sheetsByTitle['Langganan'];

        if (!sheetLangganan) {
          await sock.sendMessage(from, { text: "Sheet 'langganan' belum tersedia." }, { quoted: msg });
          return;
        }

        const rows = await sheetLangganan.getRows();
        const namaTarget = (data.nama_layanan || '').toLowerCase();
        const found = rows.find(row => {
          const idSub = (row.get('id_langganan') || row._rawData[0] || '').toLowerCase();
          const nama = (row.get('nama_layanan') || row.get('Nama_Layanan') || row._rawData[1] || '').toLowerCase();
          const status = (row.get('status') || row.get('Status') || row._rawData[7] || '').toLowerCase();
          return (nama.includes(namaTarget) || idSub === namaTarget) && status === 'aktif';
        });

        if (!found) {
          await sock.sendMessage(from, { text: `⚠️ Langganan "${data.nama_layanan}" tidak ditemukan atau sudah nonaktif.` }, { quoted: msg });
          return;
        }

        // Ambil data langganan
        const idLangganan = found.get('id_langganan') || found._rawData[0] || '-';
        const namaLayanan = found.get('nama_layanan') || found.get('Nama_Layanan') || found._rawData[1];
        const nominal = parseRupiah(found.get('nominal') || found.get('Nominal') || found._rawData[2] || '0');
        const kategori = found.get('kategori') || found.get('Kategori') || found._rawData[6] || 'tagihan';
        const sumber = found.get('sumber_default') || found.get('Sumber_Default') || found._rawData[5] || 'cash';

        // Catat ke sheet transaksi
        const sheetTransaksi = doc.sheetsByTitle['transaksi'] || doc.sheetsByIndex[0];
        await sheetTransaksi.loadHeaderRow();
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const idTrx = await generateTrxId(sheetTransaksi);

        await sheetTransaksi.addRow({
          id_transaksi: idTrx,
          timestamp: timestamp,
          wa_id: waId.split('@')[0],
          tipe: 'pengeluaran',
          kategori: kategori,
          keterangan: `Bayar tagihan ${namaLayanan}`,
          nominal: nominal,
          sumber: sumber
        });

        const reply = `✅ *TAGIHAN BERHASIL DIBAYAR*\n\n` +
          `• ID TRX       : ${idTrx}\n` +
          `• ID Langganan : ${idLangganan}\n` +
          `• Layanan      : ${namaLayanan}\n` +
          `• Nominal      : Rp ${nominal.toLocaleString('id-ID')}\n` +
          `• Sumber       : ${sumber}\n` +
          `• Kategori     : ${kategori}\n\n` +
          `_Sudah otomatis tercatat sebagai pengeluaran di sheet transaksi._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 9: HAPUS LANGGANAN =====
      } else if (data.action === "hapus_langganan") {
        const doc = await getDoc(sheetId);
        const sheetLangganan = doc.sheetsByTitle['langganan'] || doc.sheetsByTitle['Langganan'];

        if (!sheetLangganan) {
          await sock.sendMessage(from, { text: "Sheet 'langganan' belum tersedia." }, { quoted: msg });
          return;
        }

        const rows = await sheetLangganan.getRows();
        const namaTarget = (data.nama_layanan || '').toLowerCase();
        const found = rows.find(row => {
          const nama = (row.get('nama_layanan') || row.get('Nama_Layanan') || '').toLowerCase();
          const status = (row.get('status') || row.get('Status') || '').toLowerCase();
          return nama.includes(namaTarget) && status === 'aktif';
        });

        if (!found) {
          await sock.sendMessage(from, { text: `⚠️ Langganan "${data.nama_layanan}" tidak ditemukan atau sudah nonaktif.` }, { quoted: msg });
          return;
        }

        const namaLayanan = found.get('nama_layanan') || found.get('Nama_Layanan');
        found.set('status', 'nonaktif');
        await found.save();

        const reply = `🚫 *LANGGANAN DIHAPUS*\n\n` +
          `Layanan *${namaLayanan}* telah dinonaktifkan.\n` +
          `_Anda tidak akan menerima pengingat untuk tagihan ini lagi._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== AKSI 10: TANYA LAPORAN =====
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
