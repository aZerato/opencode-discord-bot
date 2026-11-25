# Configuration Discord — OpenCode Discord Bridge

Ce document explique, **de zéro à zéro**, comment créer l'application Discord, configurer le bot, l'installer sur votre serveur privé, et remplir le fichier `.env` requis par le pont OpenCode.

Il complète :
- `architecture.md` (§6 *Variables d'Environnement Requises*)
- `README.md` (aperçu et commandes)

> **Rappel des besoins du pont** : le client Discord.js est initialisé avec trois intents — `Guilds`, `GuildMessages` et **`MessageContent`** (voir `src/discord/client.ts`). L'intent `MessageContent` est *privilégié* : il **doit** être activé manuellement dans le portail développeur, sinon le bot lève `Used disallowed intents` au démarrage (§8).

---

## 0. Vue d'ensemble des identifiants à récupérer

| Variable `.env` | D'où le récupérer |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Portail développeur → **Bot** → *Reset Token* |
| `DISCORD_GUILD_ID` | ID du **serveur** (mode développeur, §1) |
| `DISCORD_LOG_CHANNEL_ID` | ID du canal **`#logs`** (mode développeur, §1) |
| `DISCORD_PROMPT_CHANNEL_ID` | ID du canal **`#prompt`** (mode développeur, §1) |
| `ALLOWED_DISCORD_USER_ID` | ID de **votre compte utilisateur** (mode développeur, §1) |
| `OTP_SECRET` | Généré par `npm run setup:otp` (§7) |

> **⚠️ Les champs `*_ID` sont des *snowflakes numériques*** (ex. `123456789012345678`). Ce ne sont **pas** des noms de canal, des URLs ni des identifiants de texte. Le **mode développeur** (§1) est indispensable pour les copier. Une valeur non numérique provoque l'erreur `guild_id … is not snowflake` (§8).

---

## 1. Activer le mode développeur Discord

Le *mode développeur* expose le clic droit → *Copier l'ID* sur les utilisateurs, canaux et le serveur. Sans lui, impossible de récupérer les snowflakes.

1. Ouvrez **Paramètres utilisateur** (engrenage en bas à gauche).
2. Allez dans **Avancé** (*Advanced*).
3. Basculez **Mode développeur** (*Developer Mode*) sur **Activé**.

Une fois activé, le clic droit révèle :
- **Copier l'ID** (*Copy ID*) sur un **utilisateur** → `ALLOWED_DISCORD_USER_ID`.
- **Copier l'ID du canal** (*Copy Channel ID*) sur un **canal texte** → `DISCORD_LOG_CHANNEL_ID` / `DISCORD_PROMPT_CHANNEL_ID`.
- **Copier l'ID du serveur** (*Copy Server ID*) sur le **serveur** → `DISCORD_GUILD_ID`.

> Alternative pour l'ID utilisateur sans mode dev : *Paramètres → Mon compte*, l'ID s'affiche en bas de page.

---

## 2. Créer l'application et le bot (portail développeur)

1. Rendez-vous sur **https://discord.com/developers/applications**.
2. **New Application** → saisissez un **Nom** (ex. `OpenCode Bridge`) → **Créer**.
3. Dans le panneau latéral, **General Information** :
   - L'**Application ID** en haut de page = le `client_id` (utilisé pour l'URL d'invitation, §4).
   - (Optionnel) configurez un **Nom d'affichage** et une **icône** pour le bot.
4. Allez dans l'onglet **Bot**.

---

## 3. Configurer le bot dans le portail

### 3.1 Activer l'intent `Message Content` (CRITIQUE)

Toujours dans l'onglet **Bot**, dans la section **Privileged Gateway Intents** :

- Activez **Message Content Intent** → **Activé**.

C'est **l'unique** intent privilégié requis par le pont. Sans cette case cochée, le serveur Discord rejette la connexion avec `Used disallowed intents` (§8).

> Les intents `Guilds` et `GuildMessages` sont utilisés mais **non** privilégiés : ils sont autorisés par défaut et n'ont pas à être cochés ici.

### 3.2 Récupérer le token du bot

Toujours dans l'onglet **Bot** :

- Section **Token** → **Reset Token** (ou *Copy*).
- Copiez la valeur dans `DISCORD_BOT_TOKEN` du `.env`.

> **Sécurité** : ce token donne un contrôle total du bot. Ne le commitez **jamais** (`.env` est en dehors du versioning, voir `.gitignore`). En cas de fuite, régénérez-le via *Reset Token*.

### 3.3 (Optionnel) Permissions par défaut de l'application

Vous pouvez pré-cocher des permissions par défaut dans **Bot → Permissions** ; ce n'est **pas** obligatoire, l'invitation (§4) impose les permissions définitives.

---

## 4. Installer l'application sur le serveur (invitation)

Cette étape **ajoute le bot à votre serveur** et lui accorde les permissions. Elle ne remplace pas l'activation de l'intent (§3.1).

1. Construisez l'URL d'invitation en remplaçant `VOTRE_CLIENT_ID` par l'**Application ID** (§2.3) :

   ```
   https://discord.com/oauth2/authorize?client_id=VOTRE_CLIENT_ID&scope=bot%20applications.commands&permissions=85056
   ```

   Décodage des paramètres :
   - `scope=bot%20applications.commands` → **`bot applications.commands`** : le *bot* + la capacité à **enregistrer les slash commands** (`/prompt`).
   - `permissions=85056` → l'entier de permissions (somme des bits ci-dessous).

2. Ouvrez l'URL dans votre navigateur → **Continuer** → **Sélectionner un serveur** → **Autoriser** → **Ajouter au serveur**.

### Bits de permissions composant `85056`

| Permission | Bit | Raison |
| --- | ---: | --- |
| `VIEW_CHANNEL` | 1024 | voir/accéder aux canaux |
| `SEND_MESSAGES` | 2048 | écrire dans `#logs` et `#prompt` |
| `EMBED_LINKS` | 16384 | afficher les **embeds** de `#prompt` (questions Oui/Non, contexte) |
| `ADD_REACTIONS` | 64 | poser la réaction **✅** après un OTP valide |
| `READ_MESSAGE_HISTORY` | 65536 | lire l'historique (flux *réponse-à-un-message*) |
| **Total** | **85056** | 1024 + 2048 + 16384 + 64 + 65536 |

---

## 5. Configurer les canaux et permissions dans le serveur

Le bot n'agit que sur **deux canaux texte**. Créez-les (ex. dans une **catégorie** dédiée) et assurez-vous qu'il dispose des permissions ci-dessus.

1. Créez deux canaux texte : **`#logs`** et **`#prompt`**.
2. En tant qu'admin, ouvrez **Paramètres du serveur → Rôles** et sélectionnez le **rôle du bot** :
   - **Afficher les canaux texte** (VIEW_CHANNEL)
   - **Envoyer des messages** (SEND_MESSAGES)
   - **Insérer des liens** (EMBED_LINKS)
   - **Ajouter des réactions** (ADD_REACTIONS)
   - **Lire l'historique des messages** (READ_MESSAGE_HISTORY)
3. **Vérifiez les autorisations de catégorie** : si `#logs`/`#prompt` sont dans une **catégorie**, l'autorisation de catégorie peut *écraser* le rôle du bot (ex. catégorie en *lecture seule*). Une cat. en *lecture seule* fait échouer l'envoi avec `Missing Access` (§8). Soit autorisez la catégorie, soit définissez l'autorisation **directement** sur chaque canal.
4. (Recommandé) restreignez l'accès au reste du serveur à votre compte et au bot, pour garder le pont **privé**.

> La commande `/prompt` est **enregistrée au niveau du serveur** (`guildId`, voir `src/discord/commands/promptModal.ts`) : elle n'apparaît que dans *ce* serveur, ce qui est cohérent avec l'usage monoserveur privé du pont.

---

## 6. Remplir le fichier `.env`

À partir de `.env.example` (template), créez un `.env` à la racine du projet :

```env
# Discord Configuration
DISCORD_BOT_TOKEN=<token du §3.2>
DISCORD_GUILD_ID=<ID du serveur — §1, §4>
DISCORD_LOG_CHANNEL_ID=<ID du canal #logs — §1>
DISCORD_PROMPT_CHANNEL_ID=<ID du canal #prompt — §1>

# Security Configuration
ALLOWED_DISCORD_USER_ID=<ID de votre compte — §1>
OTP_SECRET=<base32 généré par §7>

# OpenCode Configuration
OPENCODE_WORKSPACE_PATH=<chemin absolu vers le projet piloté>
LOG_FLUSH_INTERVAL_MS=3000
```

Règles de saisie :
- **Pas de guillemets**, pas d'espaces, valeurs brutes.
- Les `*_ID` sont **numériques** (snowflakes) — pas de `< >` ni de texte.
- `OPENCODE_WORKSPACE_PATH` est un **chemin absolu** (ex. `C:\chemin\vers\projet` ou `/chemin/vers/projet`).
- `LOG_FLUSH_INTERVAL_MS` est un entier en millisecondes (3000 = 3 s, valeur par défaut de l'architecture).

La validation stricte de ces variables est faite par **Zod** au démarrage (`src/config/env.ts`) ; une valeur mal formée bloque le démarrage avec un message explicite.

---

## 7. Générer le secret OTP

Le secret TOTP n'est **pas** fourni par Discord ; il est généré localement par le script :

```bash
npm run setup:otp
```

Le script :
1. génère un **secret Base32** via `authenticator.generateSecret()`,
2. construit l'URI `otpauth://totp/...` et affiche un **QR code** dans le terminal,
3. affiche le secret à copier dans `.env` → `OTP_SECRET`.

Procédez ainsi :
- Scannez le QR code (ou saisissez le secret) dans **Microsoft Authenticator** / **Google Authenticator** / **Aegis**.
- Copiez le **secret Base32** affiché dans `OTP_SECRET`.

> `npm run setup:otp` génère un **nouveau** secret à chaque exécution. Si vous le relancez, remplacez `OTP_SECRET` dans le `.env` et **re-scannez** le QR. La vérification utilise une tolérance d'**1 pas de temps** (`window: 1`) et **bloque 5 min après 3 échecs** (anti brute-force, `src/security/otpService.ts`).

---

## 8. Dépannage (erreurs Discord courantes)

| Symptôme | Cause | Remède |
| --- | --- | --- |
| `Used disallowed intents` | L'intent **`Message Content`** n'est pas activé dans le portail (§3.1) | Activez *Message Content Intent* sous l'onglet **Bot** |
| `guild_id … is not snowflake` / `Invalid Form Body` | Une variable `*_ID` contient du texte au lieu d'un **snowflake numérique** | Copiez les IDs réels via le **mode développeur** (§1) |
| `Missing Access` (50001) sur `#logs` | Le bot n'a pas **Afficher le canal** / **Envoyer des messages**, ou une **catégorie** écrase l'autorisation | Autorisez le rôle du bot (et/ou le canal) — §5.3 |
| Les embeds de `#prompt` ne s'affichent pas | Le bot n'a pas **Écrire des liens / embed** | Ajoutez `EMBED_LINKS` (§5) |
| La réaction ✅ ne se pose pas | Le bot n'a pas **Ajouter des réactions** | Ajoutez `ADD_REACTIONS` (§5) |
| `/prompt` n'apparaît pas | L'invitation sans scope `applications.commands`, ou commande enregistrée sur un autre serveur | Re-faites l'invitation (§4) ; la commande est *guild-scoped* (§5) |

---

## 9. Checklist de mise en route

1. Mode développeur activé (§1) et IDs copiés.
2. Application + bot créés (§2).
3. **`Message Content Intent`** activé (§3.1) — *le point qui bloque le plus souvent*.
4. Token récupéré (§3.2).
5. Bot invité au serveur avec `permissions=85056` et scope `bot applications.commands` (§4).
6. Canaux `#logs`/`#prompt` créés, permissions vérifiées y compris au niveau **catégorie** (§5).
7. `.env` rempli (IDs **numériques**) et `OTP_SECRET` généré via `npm run setup:otp` (§6, §7).
8. Lancement : `npm run dev` (dev) ou `npm start` (prod) — voir `README.md`.
