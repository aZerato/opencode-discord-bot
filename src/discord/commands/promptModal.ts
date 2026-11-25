import {
  ApplicationCommandType,
  TextInputBuilder,
  TextInputStyle,
  type ApplicationCommandDataResolvable,
  ModalBuilder,
  type Client,
} from 'discord.js';

export const PROMPT_COMMAND_NAME = 'prompt';
export const PROMPT_MODAL_CUSTOM_ID = 'opencode-prompt';
export const OTP_FIELD_ID = 'otp_code';
export const INSTRUCTION_FIELD_ID = 'instruction';

/** Définition de la commande slash `/prompt`. */
export function promptCommandDefinition(): ApplicationCommandDataResolvable {
  return {
    name: PROMPT_COMMAND_NAME,
    type: ApplicationCommandType.ChatInput,
    description: 'Soumettre une instruction à OpenCode (authentification OTP requise).',
    options: [],
  };
}

/**
 * Modale Discord : deux champs — « Code OTP (6 chiffres) » et
 * « Instruction OpenCode ».
 */
export function buildPromptModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(PROMPT_MODAL_CUSTOM_ID)
    .setTitle('Nouvelle instruction OpenCode')
    .addComponents(
      new TextInputBuilder()
        .setCustomId(OTP_FIELD_ID)
        .setLabel('Code OTP (6 chiffres)')
        .setPlaceholder('000000')
        .setMaxLength(6)
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
      new TextInputBuilder()
        .setCustomId(INSTRUCTION_FIELD_ID)
        .setLabel('Instruction OpenCode')
        .setPlaceholder('Ex : Crée un composant React …')
        .setMaxLength(1900)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true),
    );
}

/**
 * Enregistre la commande `/prompt` au niveau du serveur (guild).
 * Le client doit être connecté (l'ID d'application est `client.user.id`).
 */
export async function registerPromptCommand(client: Client, guildId: string): Promise<void> {
  const application = client.application;
  if (!application) {
    throw new Error('Le client Discord n\'est pas prêt : application indisponible.');
  }
  await application.commands.set([promptCommandDefinition()], guildId);
}
