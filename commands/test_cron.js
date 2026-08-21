const { runReminderCheck } = require('../subscriptionReminder');

module.exports = {
  name: "test_cron",
  description: "Debug: jalankan logika cek langganan secara langsung (sama persis dengan cron jam 09:00)",
  execute: async (sock, from, args, msg) => {
    await sock.sendMessage(from, { text: "⏳ Menjalankan logika cek langganan (debug mode)..." }, { quoted: msg });

    // Panggil fungsi reminder yang sama persis, kirim debug log ke chat ini
    await runReminderCheck(sock, from);
  }
};
