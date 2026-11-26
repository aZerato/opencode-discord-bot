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
  /** Ligne de log produite par OpenCode (transcript lisible, vers #logs). */
  log: (line: string) => void;
  /** Raisonnement/réflexion du modèle (remonté dans #prompt). */
  thinking: (text: string) => void;
  /** Réponse textuelle du modèle, le « retour » du prompt (remonté dans #prompt). */
  response: (text: string) => void;
  /** OpenCode demande une entrée utilisateur (validation, choix…). */
  question: (question: OpenCodeQuestion) => void;
  /** Le prompt en cours s'est terminé avec succès. */
  done: () => void;
  /** Erreur d'exécution ou d'intégration. */
  error: (err: Error) => void;
}

/** Forme minimale d'un événement du flux JSON d'`opencode run --format json`. */
interface OpencodeStreamPart {
  type?: string;
  text?: string;
  tool?: string;
  title?: string;
}
interface OpencodeStreamEvent {
  type?: string;
  part?: OpencodeStreamPart;
}

/**
 * Interface découplée vers OpenCode : `EventEmitter` typé émettant
 * `log`, `question`, `done`, `error`.
 *
 * Deux stratégies de communication sont envisagées par l'architecture :
 *  - `CliOpenCodeAdapter` (fourni ici) : spawn du CLI, prompt passé en
 *    argument (`opencode run <prompt>`), sortie parsée ligne à ligne ; le
 *    `stdin` de l'enfant est scellé en `ignore` car `opencode run` bloque
 *    sur un pipe `stdin` ouvert ;
 *  - un adaptateur API locale (WebSocket/HTTP) pourra être branché sur la
 *    même interface sans toucher au reste du pipeline.
 */
export abstract class OpenCodeAdapter extends EventEmitter {
  /** Transmet un prompt à OpenCode (un prompt à la fois pour la variante CLI). */
  abstract submit(prompt: string): Promise<void>;
  /**
   * Transmet la réponse utilisateur à OpenCode. Pour la variante CLI one-shot
   * c'est un no-op propre (le `stdin` est scellé en `ignore`) ; c'est le point
   * d'ancrage de la réinjection pour la variante API.
   */
  abstract answer(response: string): void;
  /** Arrêt propre de l'adaptateur. */
  abstract stop(): Promise<void>;

  // --- Abonnements typés (EventEmitter) ---
  override on(event: 'log', listener: OpenCodeAdapterEvents['log']): this;
  override on(event: 'thinking', listener: OpenCodeAdapterEvents['thinking']): this;
  override on(event: 'response', listener: OpenCodeAdapterEvents['response']): this;
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
  /**
   * Auto-approve des permissions d'outils OpenCode (flag `--auto`).
   * Par défaut `true` : indispensable pour un `run` non-interactif piloté par
   * le bot. Sans `--auto`, un prompt qui nécessite un outil (ex. écrire un
   * fichier, lancer une commande) attend une approbation qui n'arrive jamais
   * (pas de terminal humain) : le processus ne ferme jamais, le drapeau
   * `busy` reste bloqué, et tout prompt suivant est refusé (« déjà occupé »).
   */
  autoApprove?: boolean;
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
    const autoApprove = this.options.autoApprove ?? true;
    const command = this.options.command ?? 'opencode';
    const args: string[] = [
      ...(this.options.baseArgs ?? ['run']),
      ...(autoApprove ? ['--auto'] : []),
      // Sortie structurée (une ligne JSON par événement) + raisonnement du
      // modèle : indispensable pour remonter réflexions/réponses dans #prompt.
      '--format',
      'json',
      '--thinking',
      prompt,
    ];
    const child = spawn(command, args, {
      cwd: this.options.workspacePath,
      // `shell: true` est nécessaire sur Windows pour résoudre les bins `.cmd`/`.exe`.
      shell: process.platform === 'win32',
      // `stdin` en `ignore` : un pipe stdin ouvert (mais jamais écrit/fermé) fait
      // bloquer `opencode run` qui l'attend → le run ne ferme jamais, `busy`
      // reste à `true` et tout prompt suivant est refusé (« déjà occupé »).
      stdio: ['ignore', 'pipe', 'pipe'],
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

  /**
   * Classifie une ligne de sortie. Avec `--format json`, chaque ligne est un
   * objet JSON typé : on en dérive les événements sémantiques
   * (`reasoning` → réflexion, `text` → réponse ou question, `tool` → action).
   * Une ligne non-JSON (bannière, avertissement) est journalisée telle quelle.
   */
  private processLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line === '') return;

    let event: OpencodeStreamEvent;
    try {
      event = JSON.parse(line) as OpencodeStreamEvent;
    } catch {
      this.pushContext(line);
      this.emit('log', line);
      return;
    }

    const part = event.part;
    if (!part) return;

    switch (part.type) {
      case 'reasoning':
        if (part.text) {
          this.pushContext(part.text);
          this.emit('log', `💭 ${part.text}`);
          this.emit('thinking', part.text);
        }
        return;
      case 'text':
        this.handleTextPart(part);
        return;
      case 'tool':
        this.emit('log', `🔧 ${part.tool ?? part.title ?? 'outil'}…`);
        return;
      default:
        // step-start / step-finish / inconnu : pas de log (le `done` vient du
        // close du processus, pas du step_finish).
        return;
    }
  }

  /** Traite un part `text` : question utilisateur (Flux A) ou réponse. */
  private handleTextPart(part: OpencodeStreamPart): void {
    const text = part.text ?? '';
    if (this.patterns.some((pattern) => pattern.test(text))) {
      const context = this.contextLines.length > 0 ? this.contextLines.join('\n') : undefined;
      this.contextLines = [];
      this.emit('question', {
        id: `q${++this.questionSeq}`,
        question: text,
        context,
        binary: /\b(yes|no|yes\/no|y\/n|oui|non|o\/n)\b/i.test(text) && /\?\s*$/.test(text),
      });
      return;
    }

    this.pushContext(text);
    this.emit('log', text);
    this.emit('response', text);
  }

  /** Met à jour le contexte glissant (dernières lignes) pour le Flux A. */
  private pushContext(line: string): void {
    this.contextLines.push(line);
    if (this.contextLines.length > 5) this.contextLines.shift();
  }
}
