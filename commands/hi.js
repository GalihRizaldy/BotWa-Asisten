
/**
 * Greets the user with a friendly hello message.
 * Usage: !hi
 */
module.exports = {
  name: "hi",
  description: "Say hello.",
  /**
   * Sends a hello message to the user.
   * @param {object} sock - WhatsApp socket instance
   * @param {string} from - Sender JID
   * @param {Array} args - Command arguments
   */
  execute: async (sock, from, args, msg) => {
    await sock.sendMessage(from, { text: "Hello! I am your bot. (Test tanpa emoji)" }, { quoted: msg });
  }
};