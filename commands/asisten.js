const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../google-credentials.json');
const config = require("../utils");

/**
 * Asisten Keuangan Pintar — Gemini AI + Spreadsheet
 * Bisa mencatat transaksi, menjawab pertanyaan keuangan, dan ngobrol biasa.
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

module.exports = {
  name: "asisten",
  description: "Asisten keuangan pintar: catat, tanya laporan, atau ngobrol.",
  execute: async (sock, from, args, msg) => {
    const apiKey = config.bot?.gemini_api_key;
    const sheetId = config.bot?.spreadsheet_id;

    if (!apiKey || !sheetId) {
      await sock.sendMessage(from, { text: "Gemini API Key atau Spreadsheet ID belum diatur di file bot.yml." }, { quoted: msg });
      return;
    }

    const prompt = args.join(" ");
    if (!prompt) {
      await sock.sendMessage(from, { text: "Mau ngapain? Contoh:\n- *Catat*: >asisten beli mie gacoan 15rb cash\n- *Tanya*: >asisten berapa total pengeluaran hari ini?\n- *Chat*: >asisten halo selamat malam" }, { quoted: msg });
      return;
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);

      // ===== TAHAP 1: DETEKSI NIAT (Intent Detection) =====
      const classifierModel = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite",
        systemInstruction: "Kamu adalah pengklasifikasi pesan. Tentukan apakah pesan pengguna bermaksud: 'catat' (mencatat transaksi keuangan baru, ada nominal/barang), 'tanya' (bertanya tentang data keuangan/laporan/rangkuman), atau 'chat' (sapaan/obrolan biasa). Balas HANYA dengan satu kata: catat, tanya, atau chat.",
      });

      const intentResult = await classifierModel.generateContent(prompt);
      const intent = intentResult.response.text().trim().toLowerCase();
      console.log(`[ASISTEN] Intent terdeteksi: "${intent}" dari pesan: "${prompt}"`);

      // ===== JALUR 1: CATAT TRANSAKSI =====
      if (intent === "catat") {
        const extractModel = genAI.getGenerativeModel({
          model: "gemini-3.1-flash-lite",
          systemInstruction: "Kamu adalah asisten pencatat keuangan. Ekstrak data transaksi dari chat pengguna.",
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                tipe: { type: "STRING", description: "Pilih: 'pemasukan' atau 'pengeluaran'" },
                kategori: { type: "STRING", description: "Contoh: makanan, kebutuhan, topup, transportasi, gaji, hiburan" },
                keterangan: { type: "STRING", description: "Deskripsi singkat transaksi" },
                nominal: { type: "NUMBER", description: "Nominal angka bulat, contoh: 15000" },
                sumber: { type: "STRING", description: "Sumber/metode pembayaran, contoh: cash, dana, gopay, bca. Jika tidak disebutkan, isi 'cash'" }
              },
              required: ["tipe", "kategori", "keterangan", "nominal", "sumber"]
            }
          }
        });

        const extractResult = await extractModel.generateContent(prompt);
        const data = JSON.parse(extractResult.response.text().trim());

        // Tulis ke Spreadsheet
        const sheet = await getSheet(sheetId, 'transaksi');
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const waId = msg.key.participant || msg.key.remoteJid;

        await sheet.addRow({
          Timestamp: timestamp,
          WA_ID: waId.split('@')[0],
          Tipe: data.tipe,
          Kategori: data.kategori,
          Keterangan: data.keterangan,
          Nominal: data.nominal,
          Sumber: data.sumber
        });

        const formatRupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(data.nominal);
        const emoji = data.tipe === 'pemasukan' ? '💰' : '💸';
        const reply = `${emoji} *Tercatat!*\n\n` +
          `• *${data.tipe.toUpperCase()}*: ${data.keterangan}\n` +
          `• *Nominal*: ${formatRupiah}\n` +
          `• *Kategori*: ${data.kategori}\n` +
          `• *Sumber*: ${data.sumber}\n\n` +
          `_Sudah masuk ke Spreadsheet._`;

        await sock.sendMessage(from, { text: reply }, { quoted: msg });

      // ===== JALUR 2: TANYA LAPORAN =====
      } else if (intent === "tanya") {
        // Baca data dari Spreadsheet untuk diberikan ke AI
        const sheet = await getSheet(sheetId, 'transaksi');
        const rows = await sheet.getRows();

        // Ambil data transaksi dan format menjadi teks ringkas
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

      // ===== JALUR 3: NGOBROL BIASA =====
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
