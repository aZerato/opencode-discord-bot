import 'dotenv/config';
import { z } from 'zod';

/**
 * Validation stricte des variables d'environnement (zod).
 * Toute variable manquante ou invalide empêche le démarrage du service.
 */
export const appEnvSchema = z.object({
  // Discord Configuration
  DISCORD_BOT_TOKEN: z.string().min(1, 'Token Discord manquant'),
  DISCORD_GUILD_ID: z.string().min(1, 'ID du serveur Discord manquant'),
  DISCORD_LOG_CHANNEL_ID: z.string().min(1, 'ID du canal #logs manquant'),
  DISCORD_PROMPT_CHANNEL_ID: z.string().min(1, 'ID du canal #prompt manquant'),
  // Security Configuration
  ALLOWED_DISCORD_USER_ID: z.string().min(1, 'ID utilisateur autorisé manquant'),
  OTP_SECRET: z.string().min(1, 'Secret OTP manquant (voir `npm run setup:otp`)'),
  // OpenCode Configuration
  OPENCODE_WORKSPACE_PATH: z.string().min(1, 'Chemin du workspace OpenCode manquant'),
  LOG_FLUSH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000, 'LOG_FLUSH_INTERVAL_MS doit être >= 1000 ms')
    .default(3000),
  // Auto-approve des permissions d'outils OpenCode (flag `--auto`). Défaut
  // `true` : indispensable pour un `run` non-interactif piloté par le bot,
  // sinon un prompt qui nécessite un outil attend une approbation qui n'arrive
  // jamais et le processus ne ferme jamais (drapeau `busy` bloqué).
  OPENCODE_AUTO_APPROVE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type AppEnv = z.infer<typeof appEnvSchema>;

/** Charge et valide l'environnement. Lève une erreur explicite si invalide. */
export function loadAppEnv(): AppEnv {
  const parsed = appEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration d'environnement invalide:\n${details}`);
  }
  return parsed.data;
}
