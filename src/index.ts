import { loadAppEnv } from './config/env.js';
import { LogBatcher } from './core/LogBatcher.js';
import { CliOpenCodeAdapter } from './core/OpenCodeAdapter.js';
import { registerPromptCommand } from './discord/commands/promptModal.js';
import { createDiscordClient } from './discord/client.js';
import { LogChannelHandler } from './discord/handlers/logChannel.js';
import { PromptChannelHandler } from './discord/handlers/promptChannel.js';
import { OtpService } from './security/otpService.js';

async function main(): Promise<void> {
  const env = loadAppEnv();

  // Discord
  const client = createDiscordClient();

  // #logs : LogBatcher (buffering + throttling) -> LogChannelHandler (envoi)
  const logChannel = new LogChannelHandler(client, env);
  const batcher = new LogBatcher({
    flushIntervalMs: env.LOG_FLUSH_INTERVAL_MS,
    maxBatchChars: 1800, // reste sous la limite Discord de 2000 caractères
    onFlush: (batch) => logChannel.sendBatch(batch),
  });
  const log = (line: string): void => batcher.push(line);
  log(`[Système] Démarrage du bridge OpenCode ↔ Discord (workspace: ${env.OPENCODE_WORKSPACE_PATH}).`);

  // OpenCode (adaptateur découplé, variante spawn CLI)
  const adapter = new CliOpenCodeAdapter({ workspacePath: env.OPENCODE_WORKSPACE_PATH });
  const otp = new OtpService(env.OTP_SECRET);

  // #prompt : interaction bidirectionnelle
  const promptChannel = new PromptChannelHandler({
    client,
    env,
    adapter,
    otp,
    log,
  });

  // Câblage des événements de l'adaptateur OpenCode
  adapter.on('log', (line) => log(line));
  adapter.on('question', (question) => {
    void promptChannel.handleQuestion(question).catch((err: unknown) => {
      log(`[ERREUR] Publication de la question: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  adapter.on('done', () => {
    void promptChannel.handleAdapterDone().catch((err: unknown) => {
      log(`[ERREUR] Confirmation de fin: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  adapter.on('error', (err) => {
    void promptChannel.handleAdapterError(err).catch(() => undefined);
  });

  // Câblage des événements Discord
  client.on('messageCreate', (message) => promptChannel.handleMessage(message));
  client.on('interactionCreate', (interaction) => promptChannel.handleInteraction(interaction));

  // Arrêt propre (SIGINT/SIGTERM) : vidage des derniers logs avant de quitter.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Arrêt propre sur ${signal}…`);
    await batcher.stop();
    await adapter.stop();
    await client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(env.DISCORD_BOT_TOKEN);
  await registerPromptCommand(client, env.DISCORD_GUILD_ID);
  log('[Système] Bot connecté, commande `/prompt` enregistrée.');
}

main().catch((err) => {
  console.error('Arrêt brutal :', err);
  process.exit(1);
});
