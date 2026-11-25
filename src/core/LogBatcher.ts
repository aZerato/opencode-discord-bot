/**
 * LogBatcher — file d'attente anti-spam pour les logs OpenCode.
 *
 * Discord impose des rate limits stricts : l'envoi brut de chaque ligne de log
 * ferait bloquer l'API. Les logs entrants sont donc accumulés en mémoire puis
 * vidés (flush) soit toutes les `flushIntervalMs`, soit dès que le seuil de
 * taille `maxBatchChars` est atteint. Le lot agrégé (un seul bloc de texte)
 * est transmis au callback `onFlush`, qui s'occupe de l'envoi Discord.
 */
export interface LogBatcherOptions {
  /** Intervalle de vidage périodique (ms). */
  flushIntervalMs: number;
  /** Seuil de taille (caractères) déclenchant un vidage immédiat. */
  maxBatchChars: number;
  /** Callback appelé avec le lot agrégé (lignes jointes par des sauts de ligne). */
  onFlush: (batch: string) => void | Promise<void>;
}

export class LogBatcher {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private lastFlush: Promise<void> = Promise.resolve();

  constructor(private readonly options: LogBatcherOptions) {
    this.timer = setInterval(() => {
      this.flush();
    }, options.flushIntervalMs);
  }

  /** Pousse une ligne dans le buffer (vidage immédiat si le seuil est atteint). */
  push(line: string): void {
    this.buffer.push(line);
    if (this.bufferSize >= this.options.maxBatchChars) {
      this.flush();
    }
  }

  /** Vide le buffer et notifie le callback avec le lot agrégé. */
  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.join('\n');
    this.buffer = [];
    this.lastFlush = Promise.resolve()
      .then(() => this.options.onFlush(batch))
      .catch((err: unknown) => {
        console.error('LogBatcher: échec du vidage du lot', err);
      });
  }

  /** Arrêt propre (SIGINT/SIGTERM) : arrête le timer puis vide les derniers logs. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.flush();
    await this.lastFlush;
  }

  private get bufferSize(): number {
    return this.buffer.reduce((sum, line) => sum + line.length + 1, 0);
  }
}
