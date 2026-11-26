import type { Client } from 'discord.js';
import stripAnsi from 'strip-ansi';
import type { AppEnv } from '../../config/env.js';
import { sendToChannel } from '../client.js';

/** Limite Discord : 2000 caractères par message. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Plafond volontairement inférieur à la limite Discord : chaque bloc envoyé
 * doit rester sous 2000 caractères une fois la clôture de code ajoutée.
 */
export const MAX_FLUSH_MESSAGE_CHARS = 1950;

/**
 * Découpe un bloc de code au niveau des sauts de ligne pour que chaque
 * message final reste sous `limit` (défaut 1950) caractères.
 * Renvoie une liste de messages prêts à envoyer (clôtures ``` incluses).
 */
export function chunkCodeBlock(
  text: string,
  limit: number = MAX_FLUSH_MESSAGE_CHARS,
): string[] {
  const open = '```bash';
  const close = '```';
  const overhead = open.length + 1 + close.length; // "```bash" + "\n" + "```"
  const innerLimit = Math.max(1, limit - overhead);
  const messages: string[] = [];
  let current = '';
  let currentSize = 0;

  const pushCurrent = (): void => {
    if (current === '') return;
    messages.push(`${open}\n${current}\n${close}`);
    current = '';
    currentSize = 0;
  };

  for (const line of text.split('\n')) {
    if (line.length > innerLimit) {
      // Ligne plus longue que le bloc : découpe dure.
      pushCurrent();
      const parts = line.match(new RegExp(`.{1,${innerLimit}}`, 'g')) ?? [];
      for (const part of parts) {
        messages.push(`${open}\n${part}\n${close}`);
      }
      continue;
    }
    const size = line.length + (currentSize === 0 ? 0 : 1);
    if (currentSize === 0 || currentSize + size <= innerLimit) {
      current = currentSize === 0 ? line : `${current}\n${line}`;
      currentSize += size;
    } else {
      pushCurrent();
      current = line;
      currentSize = line.length;
    }
  }
  pushCurrent();
  return messages;
}

/**
 * Gestion de l'envoi dans #logs : nettoyage ANSI, agrégation du lot en bloc
 * de code et envoi Discord (découpe si le bloc dépasse 1950 caractères).
 */
export class LogChannelHandler {
  constructor(
    private readonly client: Client,
    private readonly env: AppEnv,
  ) {}

  /** Envoie un lot de logs (lot déjà agrégé par le LogBatcher). */
  async sendBatch(batch: string): Promise<void> {
    const clean = stripAnsi(batch);
    for (const chunk of chunkCodeBlock(clean)) {
      const sent = await sendToChannel(this.client, this.env.DISCORD_LOG_CHANNEL_ID, {
        content: chunk,
      });
      if (!sent) break; // canal indisponible : on abandonne le reste du lot
    }
  }
}
