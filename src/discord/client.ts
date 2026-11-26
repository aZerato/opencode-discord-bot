import {
  Client,
  GatewayIntentBits,
  TextChannel,
  type Channel,
  type MessageCreateOptions,
} from 'discord.js';

/**
 * Initialisation du client Discord.js avec les intents requis par l'architecture :
 * `Guilds`, `GuildMessages` et `MessageContent` (intent privilégié — à activer
 * dans le portail développeur Discord).
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

/**
 * Garde de type : `client.channels.fetch` retourne un `Channel` (union qui
 * inclut aussi `CategoryChannel`/`VoiceChannel` non envoyables). On ne
 * conserve que les canaux texte de serveur, seuls à exposer `send`.
 */
function isTextChannel(channel: Channel): channel is TextChannel {
  return channel instanceof TextChannel;
}

/**
 * Envoie un message vers un canal identifié par son ID.
 * Renvoie false si le canal n'existe pas (ne lève pas).
 */
export async function sendToChannel(
  client: Client,
  channelId: string,
  options: MessageCreateOptions,
): Promise<boolean> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !isTextChannel(channel)) return false;
  await channel.send(options);
  return true;
}
