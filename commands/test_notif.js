module.exports = {
  name: "test_notif",
  description: "Tes pengiriman notifikasi otomatis 1 menit ke depan",
  execute: async (sock, from, args, msg) => {
    await sock.sendMessage(from, { text: "⏳ Sip, saya akan kirim pesan tes notifikasi otomatis ke nomor target (berdasarkan owner_number di bot.yml) dalam 1 menit ke depan..." }, { quoted: msg });
    
    setTimeout(async () => {
      const config = require('../utils');
      const ownerNumber = config.bot?.owner_number;
      
      let target = null;
      if (ownerNumber) {
        const raw = ownerNumber.toString().trim();
        if (raw.includes('@')) {
          target = raw.replace(/:\d+@/, '@');
        } else {
          target = `${raw}@s.whatsapp.net`;
        }
      }

      if (!target) {
        await sock.sendMessage(from, { text: "❌ Tes gagal: owner_number belum diatur di bot.yml." });
        return;
      }

      try {
        await sock.sendMessage(target, { 
          text: "🔔 *TES NOTIFIKASI BERHASIL*\n\nHalo! Jika Anda menerima pesan ini, berarti jalur pengiriman notifikasi (baik ke Grup maupun ke Local ID / LID) sudah berfungsi dengan sempurna. Bot siap digunakan untuk mengirim pengingat tagihan bulanan! ✅"
        });
        console.log(`[TEST] Pesan tes berhasil dikirim ke ${target}`);
      } catch (err) {
        console.error(`[TEST] Gagal mengirim pesan tes:`, err);
        await sock.sendMessage(from, { text: `❌ Gagal mengirim pesan tes ke target: ${err.message}` });
      }
    }, 60000); // 60 detik = 1 menit
  }
};
