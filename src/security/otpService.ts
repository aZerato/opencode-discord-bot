import { authenticator } from 'otplib';

const MAX_CONSECUTIVE_FAILURES = 3;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface OtpVerifyResult {
  /** true si le code fourni est valide. */
  ok: boolean;
  /** true si le compte est verrouillé (trop d'échecs consécutifs). */
  blocked: boolean;
}

/**
 * Wrapper autour d'otplib : vérification TOTP (RFC 6238) compatible
 * Microsoft / Google Authenticator, avec fenêtre de tolérance d'un pas de
 * temps (`window: 1`) pour pallier les légers décalages d'horloge, et
 * protection anti brute-force (verrouillage de 5 minutes après 3 échecs
 * consécutifs).
 */
export class OtpService {
  private consecutiveFailures = 0;
  private lockedUntilMs = 0;

  /**
   * Instance dédiée à `window: 1` (le preset par défaut d'otplib utilise
   * `window: 0`, trop strict pour une horloge décalée d'un pas).
   *
   * On utilise `clone` (et **non** `create`) : `create` fabrique une instance
   * « nue » qui **perd** les plugins base32 (`keyDecoder`/`createDigest`)
   * injectés par le preset, et `check()` lèverait alors systématiquement
   * (`Expecting options.keyDecoder to be a function.`). `clone` préserve ces
   * plugins tout en appliquant `window: 1`.
   */
  private readonly authenticator = authenticator.clone({ window: 1 });

  constructor(private readonly secret: string) {}

  /** Vérifie un code TOTP (6 chiffres). */
  verify(code: string): OtpVerifyResult {
    const now = Date.now();
    if (now < this.lockedUntilMs) {
      return { ok: false, blocked: true };
    }

    const valid = this.authenticator.check(code, this.secret);
    if (valid) {
      this.consecutiveFailures = 0;
      return { ok: true, blocked: false };
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.consecutiveFailures = 0;
      this.lockedUntilMs = now + LOCKOUT_MS;
    }
    return { ok: false, blocked: false };
  }

  /** Instant (ms) à laquelle le verrou anti brute-force se lève. */
  lockedUntil(): number {
    return this.lockedUntilMs;
  }

  /**
   * Valide le secret au démarrage : lève une erreur **explicite** s'il n'est
   * pas du base32 valide. Sans ça, `authenticator.check` lèverait à la volée
   * (caractère hors base32) et ferait planter l'ACK d'une interaction Discord.
   */
  assertValidSecret(): void {
    try {
      // Un secret valide ne lève pas (le code est juste refusé) ; un secret
      // invalide lève dans le décodeur base32.
      this.authenticator.check('000000', this.secret);
    } catch {
      throw new Error(
        'Le secret OTP est invalide. Utilisez le secret base32 généré par `npm run setup:otp` et collez-le dans OTP_SECRET (sans guillemets, sans espace).',
      );
    }
  }
}
