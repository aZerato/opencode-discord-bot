# Architecture Technique : OpenCode Discord Bot

## 1. Vue d'ensemble du Projet
Ce projet consiste en un service local développé en **Node.js / TypeScript** agissant comme un pont (bridge) bidirectionnel entre une instance locale d'**OpenCode** (agent de développement IA) et un serveur **Discord** privé. 

L'objectif est de permettre à l'utilisateur de monitorer l'exécution d'OpenCode à distance, de répondre à ses demandes de validation/clarification, et d'initier de nouvelles tâches de manière hautement sécurisée.

---

## 2. Stack Technique Recommandée

*   **Runtime :** Node.js (v20+ LTS)
*   **Langage :** TypeScript (mode `strict` activé)
*   **Client Discord :** `discord.js` (v14+) — Gestion des Intents (`Guilds`, `GuildMessages`, `MessageContent`), des Embeds et des Composants Interactifs (Boutons/Modals).
*   **Authentification OTP :** `otplib` — Génération et vérification de secrets TOTP (RFC 6238) compatibles avec Microsoft Authenticator / Google Authenticator, accompagné de `qrcode` pour l'initialisation en CLI.
*   **Intégration OpenCode :** 
    *   SDK / API HTTP/WebSocket locale d'OpenCode (si exposée).
*   **Gestion de Configuration & Logs internes :** `dotenv` + `zod` (validation stricte des variables d'environnement).

---

## 3. Architecture Logique & Flux de Données

```text
+-------------------+       IPC / Stdio / Local API      +-----------------------+
|                   | <--------------------------------> |                       |
|  OpenCode Local   |                                    |  Node.js Bridge App   |
|  (CLI / Daemon)   |       Events (Logs, Prompts)       |                       |
+-------------------+ ---------------------------------> +-----------------------+
                                                                   |     ^
                                            Discord API (WS/REST)  |     |
                                            +----------------------+     |
                                            v                            |
                             +-----------------------------+             |
                             |       Serveur Discord       |             |
                             |                             |             |
                             |  #logs (LogBatcher)         |             |
                             |  #prompt (Interactive + OTP)| ------------+
                             +-----------------------------+
```

---

## 4. Spécifications des Fonctionnalités Clés

### 4.1. Canal `#logs` (Système de Batching Anti-Spam)
Discord impose des limites de débit strictes (Rate Limits). L'envoi brut des logs d'OpenCode entraînerait un blocage de l'API.

*   **Composant :** `LogBatcher`
*   **Fonctionnement :**
    1.  Les logs entrants d'OpenCode sont poussés dans une file d'attente en mémoire (`buffer: string[]`).
    2.  Un timer (ex: toutes les `3000ms`) ou un seuil de taille (ex: `1800 caractères` pour rester sous la limite Discord de 2000 caractères) déclenche le vidage (flush) du buffer.
    3.  Les logs accumulés sont nettoyés (suppression des codes couleurs ANSI via `strip-ansi`), agrégés et envoyés en un seul message formaté en bloc de code (` ```bash ... ``` `).
    4.  Si un bloc dépasse 1950 caractères, il est découpé intelligemment au niveau des sauts de ligne.

### 4.2. Canal `#prompt` (Interaction Bidirectionnelle)

#### Flux A : OpenCode pose une question à l'utilisateur (Outbound)
1.  L'adaptateur OpenCode détecte une demande d'entrée utilisateur (ex: validation d'une commande shell, choix d'architecture).
2.  Le bot publie un **Discord Embed** dans `#prompt` contenant le contexte et la question.
3.  *UX améliorée :* Si la question est binaire (Oui/Non), attacher des `ActionRow` avec des boutons Discord. Sinon, attendre une réponse textuelle (`Reply`) de l'utilisateur autorisé.
4.  La réponse de l'utilisateur est réinjectée dans le flux `stdin` ou l'API d'OpenCode.

#### Flux B : L'utilisateur soumet un nouveau prompt (Inbound + Sécurité OTP)
L'exécution de code arbitraire via Discord représente un risque critique. L'authentification forte est obligatoire.

1.  **Vérification d'identité :** Vérifier que `message.author.id === process.env.ALLOWED_DISCORD_USER_ID`. Ignorer silencieusement tout autre utilisateur.
2.  **Mécanisme TOTP (Microsoft Authenticator) :**
    *   **Mode Inline (Rapide) :** L'utilisateur préfixe son message avec son code à 6 chiffres : `!run [123456] Crée un composant React...` ou `123456: Crée un composant...`.
    *   **Mode Interactif (Slash Command) :** L'utilisateur tape `/prompt`, ce qui ouvre une **Discord Modal** contenant deux champs : `Code OTP (6 chiffres)` et `Instruction OpenCode`.
3.  **Validation :** `authenticator.check(otpToken, process.env.OTP_SECRET)`.
    *   *Si valide :* Suppression immédiate du message contenant le code OTP (hygiène de sécurité), confirmation visuelle via réaction (`✅`), et transmission du prompt à OpenCode.
    *   *Si invalide :* Rejet de la commande, log d'alerte sécurité dans `#logs`, et implémentation d'un compteur d'échecs (rate-limiting local contre le brute-force).

---

## 5. Structure des Répertoires (Cible pour l'Agent de Code)

```text
opencode-discord-bot/
├── src/
│   ├── config/
│   │   └── env.ts                 # Validation Zod des variables d'env
│   ├── core/
│   │   ├── OpenCodeAdapter.ts     # Interface abstrayant le CLI/API OpenCode
│   │   └── LogBatcher.ts          # File d'attente et throttling des logs
│   ├── discord/
│   │   ├── client.ts              # Initialisation du client Discord.js
│   │   ├── handlers/
│   │   │   ├── logChannel.ts      # Gestion de l'envoi dans #logs
│   │   │   └── promptChannel.ts   # Gestion des messages/interactions dans #prompt
│   │   └── commands/
│   │       └── promptModal.ts     # Slash command /prompt + Modal OTP
│   ├── security/
│   │   └── otpService.ts          # Wrapper otplib + protection anti brute-force
│   ├── scripts/
│   │   └── setup-otp.ts           # Script CLI pour générer le secret et afficher le QR Code
│   └── index.ts                   # Point d'entrée et orchestration
├── .env.example                   # Template de configuration
├── package.json
└── tsconfig.json
```

---

## 6. Variables d'Environnement Requises (`.env`)

```env
# Discord Configuration
DISCORD_BOT_TOKEN=votre_token_bot
DISCORD_GUILD_ID=id_du_serveur
DISCORD_LOG_CHANNEL_ID=id_du_canal_logs
DISCORD_PROMPT_CHANNEL_ID=id_du_canal_prompt

# Security Configuration
ALLOWED_DISCORD_USER_ID=votre_id_utilisateur_discord
OTP_SECRET=secret_base32_genere_par_setup_script

# OpenCode Configuration
OPENCODE_WORKSPACE_PATH=/chemin/vers/votre/projet
LOG_FLUSH_INTERVAL_MS=3000
```

---

## 7. Instructions d'Implémentation pour l'Agent de Code

1.  **Initialisation :** Créer le projet Node/TypeScript avec `tsconfig.json` configuré pour ES2022/NodeNext. Installer `discord.js`, `otplib`, `qrcode`, `dotenv`, `zod`, `strip-ansi` (et `@types/qrcode` en dev).
2.  **Script Setup OTP (`src/scripts/setup-otp.ts`) :** Créer un script exécutable via `npm run setup:otp` qui génère un secret via `authenticator.generateSecret()`, construit l'URI `otpauth://totp/OpenCode:Admin?secret=...&issuer=OpenCode`, affiche le QR Code dans le terminal via `qrcode.toString(uri, { type: 'terminal' })` et affiche le secret à copier dans le `.env`.
3.  **LogBatcher (`src/core/LogBatcher.ts`) :** Implémenter une classe utilisant `EventEmitter` ou un callback `onFlush(batch: string)`. Gérer proprement l'arrêt (`SIGINT`/`SIGTERM`) pour vider les derniers logs avant de quitter.
4.  **Sécurité (`src/security/otpService.ts`) :** Inclure une fenêtre de tolérance de 1 pas de temps (`window: 1` dans `otplib`) pour pallier les légers décalages d'horloge, et bloquer toute tentative pendant 5 minutes après 3 échecs consécutifs.
5.  **OpenCodeAdapter (`src/core/OpenCodeAdapter.ts`) :** Concevoir une interface découplée (`EventEmitter` émettant `'log'`, `'question'`, `'done'`, `'error'`) afin de pouvoir facilement adapter la méthode de communication avec OpenCode (spawn CLI vs API locale).