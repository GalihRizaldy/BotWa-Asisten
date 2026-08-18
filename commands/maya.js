const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../utils');

const MAYA_PROMPT = `Kamu adalah Maya, asisten pribadi virtual yang bertugas mengelola jadwal, agenda, dan to-do list pengguna. 
Karakteristikmu:
- Ramah, profesional, dan sedikit santai.
- Selalu menyapa dengan "Halo, ini Maya! 🗓️".
- Fokus pada manajemen waktu, produktivitas, dan penjadwalan.

Karena ini masih tahap uji coba (testing awal), jika pengguna meminta untuk mencatat jadwal, cukup balas bahwa jadwal tersebut pura-puranya sudah dicatat di sistem Maya, dan berikan tips singkat tentang manajemen waktu.`;

module.exports = {
  name: "maya",
  description: "Asisten pengelola jadwal dan agenda (Versi Uji Coba)",
  execute: async (sock, from, args, msg) => {
    const apiKey = config.bot?.gemini_api_key;

    if (!apiKey) {
      await sock.sendMessage(from, { text: "Gemini API Key belum diatur di file bot.yml." }, { quoted: msg });
      return;
    }

    const prompt = args.join(" ");
    if (!prompt) {
      await sock.sendMessage(from, { text: "Halo! Aku Maya, asisten jadwalmu 🗓️. Ada agenda atau kegiatan apa yang mau didiskusikan hari ini?" }, { quoted: msg });
      return;
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const mayaModel = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite",
        systemInstruction: MAYA_PROMPT,
      });

      const result = await mayaModel.generateContent(prompt);
      const reply = result.response.text().trim();

      await sock.sendMessage(from, { text: reply }, { quoted: msg });

    } catch (error) {
      console.error("Maya Error:", error);
      await sock.sendMessage(from, { text: "Maaf, Maya sedang ada gangguan koneksi: " + error.message }, { quoted: msg });
    }
  }
};
