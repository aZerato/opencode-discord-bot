import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type Client,
  type Interaction,
  type Message,
  type MessageCreateOptions,
} from 'discord.js';
import type { MessageActionRowComponentBuilder } from '@discordjs/builders';
import type { AppEnv } from '../../config/env.js';
import type { OpenCodeAdapter, OpenCodeQuestion } from '../../core/OpenCodeAdapter.js';
import type { OtpService } from '../../security/otpService.js';
import {
  buildPromptModal,
  INSTRUCTION_FIELD_ID,
  OTP_FIELD_ID,
  PROMPT_COMMAND_NAME,
  PROMPT_MODAL_CUSTOM_ID,
} from '../commands/promptModal.js';
import { sendToChannel } from '../client.js';

/** Résultat parsé d'un message préfixé par un code OTP inline. */
export interface InlineOtp {
  code: string;
  prompt: string;
}

/**
 * Parse les formats inline :
 *  - `!run [123456] Crée un composant React…`
 *  - `123456: Crée un composant…`
 */
export function parseInlineOtp(content: string): InlineOtp | null {
  const bracket = content.match(/^\s*!run\s*\[\s*(\d{6})\s*\]\s+([\s\S]+)$/i);
  if (bracket) {
    const [, code, prompt] = bracket;
    if (code && prompt) return { code, prompt: prompt.trim() };
  }
  const colon = content.match(/^\s*(\d{6})\s*:\s+([\s\S]+)$/);
  if (colon) {
    const [, code, prompt] = colon;
    if (code && prompt) return { code, prompt: prompt.trim() };
  }
  return null;
}

function statusEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder().setColor(0x2f3136).setDescription(text);
}

function rejectMessage(blocked: boolean, lockedUntilMs: number): string {
  if (blocked) {
    return `⛔ Authentification OTP bloquée (trop d'échecs consécutifs). Réessayez après le ${new Date(lockedUntilMs).toLocaleString('fr-FR')}.`;
  }
  return '❌ Code OTP invalide.';
}

/**
 * Gestion du canal #prompt :
 *  - Flux A (outbound) : les questions d'OpenCode y sont publiées (embed +
 *    boutons si binaire) et les réponses de l'utilisateur y sont réinjectées ;
 *  - Flux B (inbound + OTP) : les prompts soumis par l'utilisateur (inline,
 *    slash command `/prompt` + modale) sont vérifiés via TOTP avant
 *    transmission. Tout utilisateur non autorisé est ignoré silencieusement.
 */
export class PromptChannelHandler {
  /** Questions en attente : id → callback de réponse. */
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();

  constructor(
    private readonly deps: {
      client: Client;
      env: AppEnv;
      adapter: OpenCodeAdapter;
      otp: OtpService;
      /** Journalisation vers #logs (via le LogBatcher). */
      log: (line: string) => void;
    },
  ) {}

  // ==================== Flux A : OpenCode → utilisateur ====================

  /** Publie une question d'OpenCode dans #prompt (embed + boutons si binaire). */
  async handleQuestion(question: OpenCodeQuestion): Promise<void> {
    this.pendingQuestions.set(question.id, (answer) => {
      this.deps.adapter.answer(answer);
      void this.postPrompt({
        embeds: [statusEmbed(`📥 Réponse transmise à OpenCode : « ${answer} »`)],
      });
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🤔 OpenCode vous pose une question')
      .setDescription(question.question)
      .setTimestamp(Date.now())
      .setFooter({
        text: question.binary
          ? 'Répondez via les boutons ci-dessous, ou en citant ce message.'
          : 'Répondez en citant (reply) ce message.',
      });
    if (question.context) {
      embed.addFields({ name: 'Contexte', value: question.context });
    }

    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (question.binary) {
      components.push(
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`q-answer:${question.id}:yes`)
            .setLabel('Oui')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
          new ButtonBuilder()
            .setCustomId(`q-answer:${question.id}:no`)
            .setLabel('Non')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌'),
        ),
      );
    }

    await this.postPrompt({
      embeds: [embed],
      ...(components.length > 0 ? { components } : {}),
    });
  }

  /** Le prompt en cours s'est terminé avec succès. */
  async handleAdapterDone(): Promise<void> {
    this.pendingQuestions.clear();
    await this.postPrompt({
      embeds: [statusEmbed('✅ Tâche OpenCode terminée.')],
    });
  }

  /** Erreur d'exécution OpenCode. */
  async handleAdapterError(err: Error): Promise<void> {
    this.pendingQuestions.clear();
    this.deps.log(`[ERREUR] OpenCode: ${err.message}`);
    await this.postPrompt({
      embeds: [statusEmbed(`❌ Erreur OpenCode : ${err.message}`)],
    });
  }

  // ==================== Flux B : utilisateur → OpenCode ====================

  /** Point d'entrée `messageCreate` (branché par le client Discord). */
  handleMessage(message: Message): void {
    void this.onMessage(message).catch((err: unknown) => {
      this.deps.log(
        `[ERREUR] Gestion du message Discord: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.channelId !== this.deps.env.DISCORD_PROMPT_CHANNEL_ID) return;
    if (!this.isAllowed(message.author.id)) return; // ignore silencieux

    const inline = parseInlineOtp(message.content);
    if (inline) {
      await this.verifyAndRun(inline.code, inline.prompt, message);
      return;
    }

    // Réponse à une question publiée dans ce canal (citer le message).
    const repliedToId = message.reference?.messageId;
    if (repliedToId && this.pendingQuestions.has(repliedToId)) {
      this.resolveQuestion(repliedToId, message.content);
      await message.react('✅').catch(() => undefined);
      return;
    }

    await message.reply({
      content:
        '💡 Pour transmettre une instruction à OpenCode, utilisez :\n' +
        '• `!run [CODE_OTP] instruction` ou `CODE_OTP: instruction` en message, ou\n' +
        '• la commande `/prompt` (modale sécurisée).',
    });
  }

  /** Point d'entrée `interactionCreate` (boutons + modale + slash command). */
  handleInteraction(interaction: Interaction): void {
    void this.onInteraction(interaction).catch((err: unknown) => {
      this.deps.log(
        `[ERREUR] Gestion de l'interaction Discord: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== PROMPT_COMMAND_NAME) return;
      if (!this.isAllowed(interaction.user.id)) return; // ignore silencieux
      await interaction.showModal(buildPromptModal());
      return;
    }

    if (interaction.isButton()) {
      const [prefix, questionId, choice] = interaction.customId.split(':');
      if (prefix !== 'q-answer' || !questionId) {
        await interaction.update({ content: '⌛ Ce bouton n\'est plus actif.', components: [] });
        return;
      }
      if (!this.isAllowed(interaction.user.id)) {
        await interaction.update({ content: '⛔ Accès refusé.', components: [] });
        return;
      }
      if (!this.resolveQuestion(questionId, choice === 'no' ? 'no' : 'yes')) {
        await interaction.update({
          content: '⌛ Cette question n\'est plus active.',
          components: [],
        });
        return;
      }
      await interaction.update({
        content: `✅ Réponse « ${choice === 'no' ? 'Non' : 'Oui'} » transmise à OpenCode.`,
        components: [],
      });
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId !== PROMPT_MODAL_CUSTOM_ID) return;
      if (!this.isAllowed(interaction.user.id)) {
        await interaction.reply({ content: '⛔ Accès refusé.', flags: MessageFlags.Ephemeral });
        return;
      }
      const code = interaction.fields.getTextInputValue(OTP_FIELD_ID).trim();
      const instruction = interaction.fields.getTextInputValue(INSTRUCTION_FIELD_ID).trim();
      const result = this.deps.otp.verify(code);
      if (!result.ok) {
        this.deps.log(
          `[SECURITE] Échec de vérification OTP (source: modale, utilisateur: ${interaction.user.id}).`,
        );
        await interaction.reply({
          content: rejectMessage(result.blocked, this.deps.otp.lockedUntil()),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Valide : réaction ✅ puis suppression du message modal (contient l'OTP).
      const original = interaction.message;
      if (original) {
        await original.react('✅').catch(() => undefined);
        await original.delete().catch(() => undefined);
      }
      await interaction.reply({
        content: '🔐 Instruction transmise à OpenCode.',
        flags: MessageFlags.Ephemeral,
      });
      await this.dispatchPrompt(instruction);
    }
  }

  // ==================== Helpers ====================

  /** Vérification OTP d'un prompt inline, puis transmission si valide. */
  private async verifyAndRun(code: string, prompt: string, message: Message): Promise<void> {
    const result = this.deps.otp.verify(code);
    if (!result.ok) {
      this.deps.log(
        `[SECURITE] Échec de vérification OTP (source: message, utilisateur: ${message.author.id}).`,
      );
      await message.reply({
        content: rejectMessage(result.blocked, this.deps.otp.lockedUntil()),
      });
      return;
    }
    // Valide : réaction ✅ puis suppression immédiate du message (hygiène sécurité).
    await message.react('✅').catch(() => undefined);
    await message.delete().catch(() => undefined);
    await this.dispatchPrompt(prompt);
  }

  /** Transmet le prompt à OpenCode et confirme visuellement. */
  private async dispatchPrompt(prompt: string): Promise<void> {
    try {
      await this.deps.adapter.submit(prompt);
      await this.postPrompt({
        embeds: [statusEmbed('🚀 Instruction transmise à OpenCode.')],
      });
    } catch (err) {
      this.deps.log(
        `[ERREUR] Impossible de transmettre le prompt: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.postPrompt({
        embeds: [
          statusEmbed("❌ Impossible de transmettre l'instruction (OpenCode déjà occupé ?)."),
        ],
      });
    }
  }

  private resolveQuestion(id: string, answer: string): boolean {
    const onAnswer = this.pendingQuestions.get(id);
    if (!onAnswer) return false;
    this.pendingQuestions.delete(id);
    onAnswer(answer);
    return true;
  }

  private isAllowed(userId: string): boolean {
    return userId === this.deps.env.ALLOWED_DISCORD_USER_ID;
  }

  private postPrompt(options: MessageCreateOptions): Promise<boolean> {
    return sendToChannel(this.deps.client, this.deps.env.DISCORD_PROMPT_CHANNEL_ID, options).catch(
      (err: unknown) => {
        this.deps.log(
          `[ERREUR] Envoi dans #prompt: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      },
    );
  }
}
