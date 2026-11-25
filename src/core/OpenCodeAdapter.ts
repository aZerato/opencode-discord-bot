import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** Question posée par OpenCode à l'utilisateur. */
export interface OpenCodeQuestion {
  /** Identifiant unique (généré par l'adaptateur). */
  id: string;
  /** Libellé de la question. */
  question: string;
  /** Dernières lignes de contexte observées sur la sortie (facultatif). */
  context?: string;
  /** true si la question est binaire (Oui/Non) — boutons Discord possibles. */
  binary: boolean;
}

export interface OpenCodeAdapterEvents {
  /** Ligne de log produite par OpenCode. */
  log: (line: string) => void;
  /** OpenCode demande une entrée utilisateur (validation, choix…). */
  question: (question: OpenCodeQuestion) => void;
  /** Le prompt en cours s'est terminé avec succès. */
  done: () => void;
  /** Erreur d'exécution ou d'intégration. */
  error: (err: Error) => void;
}

/**
 * Interface découplée vers OpenCode : `EventEmitter` typé émettant
 * `log`, `question`, `done`, `error`.
 *
 * Deux stratégies de communication sont envisagées par l'architecture :
 *  - `CliOpenCodeAdapter` (fourni ici) : spawn du CLI, prompts écrits dans
 *    le flux `stdin`, sortie parsée ligne à ligne ;
 *  - un adaptateur API locale (WebSocket/HTTP) pourra être branché sur la
 *    même interface sans toucher au reste du pipeline.
 */
export abstract class OpenCodeAdapter extends EventEmitter {
  /** Transmet un prompt à OpenCode (un prompt à la fois pour la variante CLI). */
  abstract submit(prompt: string): Promise<void>;
  /** Réinjecte la réponse utilisateur dans le flux `stdin` (ou l'API). */
  abstract answer(response: string): void;
  /** Arrêt propre de l'adaptateur. */
  abstract stop(): Promise<void>;

  // --- Abonnements typés (EventEmitter) ---
  override on(event: 'log', listener: OpenCodeAdapterEvents['log']): this;
  override on(event: 'question', listener: OpenCodeAdapterEvents['question']): this;
  override on(event: 'done', listener: OpenCodeAdapterEvents['done']): this;
  override on(event: 'error', listener: OpenCodeAdapterEvents['error']): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

export interface CliOpenCodeAdapterOptions {
  /** Chemin du workspace OpenCode (dossier du projet). */
  workspacePath: string;
  /** Commande à invoquer (défaut : `opencode`). */
  command?: string;
  /** Arguments de base du sous-processus (défaut : `run`). */
  baseArgs?: string[];
  /** Motifs complémentaires de détection des questions. */
  questionPatterns?: RegExp[];
}

/**
 * Référence d'implémentation « spawn CLI » : chaque prompt lance
 * `opencode run <prompt>` dans le workspace ; la sortie (stdout + stderr)
 * est parsée ligne à ligne — les lignes ressemblant à une question
 * utilisateur (validation de commande shell, choix…) sont détachées du
 * flux de logs et re-déclenchées via l'événement `question`.
 */
export class CliOpenCodeAdapter extends OpenCodeAdapter {
  private child: ChildProcess | null = null;
  private stdoutBuffer = '';
  private contextLines: string[] = [];
  private questionSeq = 0;
  private busy = false;
  private stopping = false;
  private readonly patterns: RegExp[];

  constructor(private readonly options: CliOpenCodeAdapterOptions) {
    super();
    this.patterns = [
      ...CliOpenCodeAdapter.defaultQuestionPatterns(),
      ...(options.questionPatterns ?? []),
    ];
  }

  /** Motifs heuristiques de détection d'une question (surcharge par `questionPatterns`). */
  static defaultQuestionPatterns(): RegExp[] {
    return [
      /^\s*\?\s+/,
      /^\s*(Do you|Would you|Shall I|Should I|May I|Can you|Let me know)\b/i,
      /^\s*(Voulez|Voulez-vous|Souhaitez|Souhaitez-vous|Puis-je|Pouvez-vous|Confirmez)\b/i,
      /\b(yes|no|yes\/no|y\/n|oui|non)\b[\s\S]*\?\s*$/i,
      /^\s*(Allow|Deny)\b.*\?\s*$/i,
    ];
  }

  /** true si un prompt est déjà en cours d'exécution. */
  get isBusy(): boolean {
    return this.busy;
  }

  submit(prompt: string): Promise<void> {
    if (this.busy) {
      return Promise.reject(
        new Error('Un prompt est déjà en cours d\'exécution côté OpenCode.'),
      );
    }
    const command = this.options.command ?? 'opencode';
    const args = [...(this.options.baseArgs ?? ['run']), prompt];
    const child = spawn(command, args, {
      cwd: this.options.workspacePath,
      // `shell: true` est nécessaire sur Windows pour résoudre les bins `.cmd`/`.exe`.
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.busy = true;
    this.stdoutBuffer = '';
    this.contextLines = [];

    child.stdout?.on('data', (chunk: Buffer) => {
      this.ingest(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.ingest(chunk.toString('utf8'));
    });
    child.on('error', (err) => {
      this.busy = false;
      this.child = null;
      this.emit('error', new Error(`Échec du spawn de « ${command} » : ${err.message}`));
    });
    child.on('close', (code) => {
      this.busy = false;
      this.child = null;
      this.ingest('\n'); // force la fin de la dernière ligne éventuellement non terminée
      this.contextLines = [];
      if (this.stopping) return;
      if (code === 0 || code === null) {
        this.emit('done');
      } else {
        this.emit('error', new Error(`OpenCode s'est terminé avec le code ${code}.`));
      }
    });
    return Promise.resolve();
  }

  answer(response: string): void {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) return;
    stdin.write(`${response}\n`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.kill();
    });
    this.child = null;
    this.busy = false;
  }

  /** Consomme un chunk de sortie et découpe en lignes complètes. */
  private ingest(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.processLine(line);
    }
  }

  /** Classifie une ligne : log simple ou question utilisateur. */
  private processLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line === '') return;

    if (this.patterns.some((pattern) => pattern.test(line))) {
      const context = this.contextLines.length > 0 ? this.contextLines.join('\n') : undefined;
      this.contextLines = [];
      this.emit('question', {
        id: `q${++this.questionSeq}`,
        question: line,
        context,
        binary: /\b(yes|no|yes\/no|y\/n|oui|non|o\/n)\b/i.test(line) && /\?\s*$/.test(line),
      });
      return;
    }

    this.contextLines.push(line);
    if (this.contextLines.length > 5) this.contextLines.shift();
    this.emit('log', line);
  }
}
