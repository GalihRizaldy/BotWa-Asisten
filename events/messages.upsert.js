// Event Handler: messages.upsert
// Description: Handles incoming messages (real-time and offline sync), parses commands, and executes them if matched.
// Triggers when a new message is received in the chat.

const config = require("./../utils");
const { registerUser } = require("./../userManager");
const prefix = config.bot?.prefix || "!";

module.exports = {
  eventName: "messages.upsert",
  /**
   * Handles new incoming messages and executes commands.
   * @param {object} sock - The WhatsApp socket instance.
   * @param {object} logger - Logger for logging info and errors.
   * @param {Map} commands - Map of available commands.
   * @returns {Function}
   */
  handler: (sock, logger, commands) => async ({ messages }) => {
    try {
      const msg = messages[0];
      logger.info(`[messages.upsert] TRIGGERED! fromMe: ${msg.key?.fromMe}, remoteJid: ${msg.key?.remoteJid}`);
      if (!msg?.message || msg.key.fromMe) {
          logger.info(`[messages.upsert] Returned early. msg.message exists: ${!!msg?.message}, fromMe: ${msg.key?.fromMe}`);
          return;
      }

      const from = msg.key.remoteJid;
      
      // Send read receipt to force blue ticks / 2 ticks
      try {
          await sock.readMessages([msg.key]);
      } catch (e) {
          logger.warn("Failed to send read receipt");
      }

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption;

      logger.info(`[messages.upsert] Extracted text: '${text}'`);

      if (!text || !text.startsWith(prefix)) {
          logger.info(`[messages.upsert] Returned early due to prefix. Prefix is '${prefix}'`);
          return;
      }
      
      logger.info("Received command", { from, text });
      const [cmdName, ...args] = text.slice(prefix.length).trim().split(" ");
      const command = commands.get(cmdName.toLowerCase());

      if (!command) {
        await sock.sendMessage(from, {
          text: `Unknown command. Type ${prefix}help to see available commands.`,
        });
        logger.warn("Unknown command received", { from, cmdName });
        return;
      }
      // Auto-register user ke sheet Users (berjalan di background, tidak blocking)
      registerUser(sock, msg).catch(() => {});

      await command.execute(sock, from, args, msg);
      logger.info("Command executed", { cmdName, from });
    } catch (err) {
      logger.error("Command handling failed", { error: err.message, stack: err.stack });
    }
  }
};
