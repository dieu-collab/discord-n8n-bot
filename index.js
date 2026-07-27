'use strict';

const express = require('express');

const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

/* =========================================================
 * 1. ĐỌC VÀ KIỂM TRA BIẾN MÔI TRƯỜNG
 * ======================================================= */

function readEnvironment(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

/*
 * Chuyển chuỗi:
 * "123,456,789"
 *
 * thành:
 * ["123", "456", "789"]
 */
function readIdList(name, fallback = '') {
  const value = readEnvironment(name, fallback);

  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const DISCORD_TOKEN =
  readEnvironment('DISCORD_TOKEN');

const N8N_WEBHOOK_URL =
  readEnvironment('N8N_WEBHOOK_URL');

/*
 * Hỗ trợ cả:
 *
 * DISCORD_GUILD_IDS
 * DISCORD_CHANNEL_IDS
 *
 * Và tên cũ:
 *
 * DISCORD_GUILD_ID
 * DISCORD_CHANNEL_ID
 * SERVER_ID
 * CHANNEL_ID
 */
const DISCORD_GUILD_IDS = readIdList(
  'DISCORD_GUILD_IDS',
  readEnvironment(
    'DISCORD_GUILD_ID',
    readEnvironment('SERVER_ID'),
  ),
);

const DISCORD_CHANNEL_IDS = readIdList(
  'DISCORD_CHANNEL_IDS',
  readEnvironment(
    'DISCORD_CHANNEL_ID',
    readEnvironment('CHANNEL_ID'),
  ),
);

/*
 * true:
 * Trong server phải tag tài khoản bot,
 * tag role bot hoặc reply tin nhắn bot.
 *
 * false:
 * Trong các kênh được phép, bot xử lý mọi tin nhắn.
 */
const REQUIRE_MENTION_IN_GUILD =
  readEnvironment(
    'REQUIRE_MENTION_IN_GUILD',
    'true',
  ).toLowerCase() !== 'false';

/*
 * true:
 * Reply tin của bot cũng được tính là gọi bot.
 */
const ALLOW_REPLY_TO_BOT =
  readEnvironment(
    'ALLOW_REPLY_TO_BOT',
    'true',
  ).toLowerCase() !== 'false';

const N8N_TIMEOUT_MS = Number(
  readEnvironment(
    'N8N_TIMEOUT_MS',
    '120000',
  ),
);

const requiredVariables = {
  DISCORD_TOKEN,
  N8N_WEBHOOK_URL,
};

const missingVariables = Object.entries(
  requiredVariables,
)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missingVariables.length > 0) {
  console.error(
    'Thiếu biến môi trường bắt buộc:',
    missingVariables.join(', '),
  );

  process.exit(1);
}

/* =========================================================
 * 2. KHỞI TẠO DISCORD CLIENT
 * ======================================================= */

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],

  partials: [
    Partials.Channel,
    Partials.Message,
  ],
});

/* =========================================================
 * 3. HÀM HỖ TRỢ
 * ======================================================= */

function extractAttachments(message) {
  return [
    ...message.attachments.values(),
  ].map((attachment) => ({
    id: String(
      attachment.id ?? '',
    ),

    name: String(
      attachment.name ?? '',
    ),

    url: String(
      attachment.url ?? '',
    ),

    proxy_url: String(
      attachment.proxyURL ?? '',
    ),

    content_type: String(
      attachment.contentType ?? '',
    ),

    size: Number(
      attachment.size ?? 0,
    ),

    width:
      attachment.width === null ||
      attachment.width === undefined
        ? null
        : Number(attachment.width),

    height:
      attachment.height === null ||
      attachment.height === undefined
        ? null
        : Number(attachment.height),
  }));
}

/*
 * Lấy các role được Discord quản lý của bot.
 */
async function getBotRoleIds(message) {
  if (
    !message.guild ||
    !discordClient.user
  ) {
    return [];
  }

  try {
    const botMember =
      message.guild.members.me ??
      await message.guild.members.fetch(
        discordClient.user.id,
      );

    if (!botMember) {
      return [];
    }

    return botMember.roles.cache
      .filter((role) => role.managed)
      .map((role) =>
        String(role.id),
      );
  } catch (error) {
    console.error(
      'Không lấy được role của bot:',
      error.message,
    );

    return [];
  }
}

/*
 * Nhận cả:
 * - Tag trực tiếp tài khoản bot.
 * - Tag role bot.
 */
async function detectBotMention(message) {
  const botUserId =
    discordClient.user?.id ?? '';

  const mentionedBotUser =
    Boolean(
      botUserId &&
      message.mentions.users.has(
        botUserId,
      ),
    );

  const botRoleIds =
    await getBotRoleIds(message);

  const mentionedBotRole =
    botRoleIds.some(
      (roleId) =>
        message.mentions.roles.has(
          roleId,
        ),
    );

  return {
    mentionedBot:
      mentionedBotUser ||
      mentionedBotRole,

    mentionedBotUser,
    mentionedBotRole,
    botRoleIds,
  };
}

/*
 * Kiểm tra người dùng có reply
 * vào tin nhắn của bot hay không.
 */
async function isReplyingToBot(message) {
  if (
    !ALLOW_REPLY_TO_BOT ||
    !message.reference?.messageId ||
    !discordClient.user
  ) {
    return false;
  }

  try {
    const repliedMessage =
      await message.channel.messages.fetch(
        message.reference.messageId,
      );

    return (
      repliedMessage.author.id ===
      discordClient.user.id
    );
  } catch {
    return false;
  }
}

/*
 * Xóa:
 * - <@BOT_ID>
 * - <@!BOT_ID>
 * - <@&ROLE_ID>
 */
function removeBotMentions(
  content,
  botUserId,
  botRoleIds = [],
) {
  let result = String(
    content ?? '',
  );

  if (botUserId) {
    result = result.replace(
      new RegExp(
        `<@!?${botUserId}>`,
        'g',
      ),
      '',
    );
  }

  for (const roleId of botRoleIds) {
    result = result.replace(
      new RegExp(
        `<@&${roleId}>`,
        'g',
      ),
      '',
    );
  }

  return result.trim();
}

/*
 * Kiểm tra server có nằm trong danh sách được phép.
 *
 * Danh sách rỗng:
 * không giới hạn server.
 */
function isAllowedGuild(guildId) {
  if (
    DISCORD_GUILD_IDS.length === 0
  ) {
    return true;
  }

  return DISCORD_GUILD_IDS.includes(
    String(guildId ?? ''),
  );
}

/*
 * Kiểm tra channel có nằm trong danh sách được phép.
 *
 * Danh sách rỗng:
 * không giới hạn channel.
 */
function isAllowedChannel(channelId) {
  if (
    DISCORD_CHANNEL_IDS.length === 0
  ) {
    return true;
  }

  return DISCORD_CHANNEL_IDS.includes(
    String(channelId ?? ''),
  );
}

/* =========================================================
 * 4. GỬI DỮ LIỆU SANG N8N
 * ======================================================= */

async function sendToN8n(payload) {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    N8N_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      N8N_WEBHOOK_URL,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Accept:
            'application/json',
        },

        body:
          JSON.stringify(payload),

        signal:
          controller.signal,
      },
    );

    const responseText =
      await response.text();

    return {
      ok: response.ok,
      status: response.status,
      responseText,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
 * 5. BOT ONLINE
 * ======================================================= */

discordClient.once(
  Events.ClientReady,
  async (client) => {
    console.log('');
    console.log(
      '====================================',
    );

    console.log(
      `Bot đã online: ${client.user.tag}`,
    );

    console.log(
      `Bot User ID: ${client.user.id}`,
    );

    console.log(
      `Số server bot nhìn thấy: ${client.guilds.cache.size}`,
    );

    console.log(
      'Danh sách server:',
      client.guilds.cache.map(
        (guild) =>
          `${guild.name} | ${guild.id}`,
      ),
    );

    console.log(
      'Server được phép:',
      DISCORD_GUILD_IDS.length > 0
        ? DISCORD_GUILD_IDS
        : 'Tất cả server',
    );

    console.log(
      'Channel được phép:',
      DISCORD_CHANNEL_IDS.length > 0
        ? DISCORD_CHANNEL_IDS
        : 'Tất cả channel',
    );

    for (
      const guildId
      of DISCORD_GUILD_IDS
    ) {
      const guild =
        client.guilds.cache.get(
          guildId,
        );

      if (guild) {
        console.log(
          `Đã tìm thấy server: ${guild.name} | ${guild.id}`,
        );
      } else {
        console.warn(
          'Không tìm thấy server:',
          guildId,
        );
      }
    }

    for (
      const channelId
      of DISCORD_CHANNEL_IDS
    ) {
      try {
        const channel =
          await client.channels.fetch(
            channelId,
          );

        if (channel) {
          console.log(
            `Đã tìm thấy channel: ${
              channel.name ??
              'Không có tên'
            } | ${channel.id}`,
          );
        } else {
          console.warn(
            'Không tìm thấy channel:',
            channelId,
          );
        }
      } catch (error) {
        console.error(
          `Không truy cập được channel ${channelId}:`,
          error.message,
        );
      }
    }

    console.log(
      'Bắt buộc tag trong server:',
      REQUIRE_MENTION_IN_GUILD,
    );

    console.log(
      'Cho phép reply để gọi bot:',
      ALLOW_REPLY_TO_BOT,
    );

    console.log(
      'Webhook n8n:',
      N8N_WEBHOOK_URL,
    );

    console.log(
      '====================================',
    );

    console.log('');
  },
);

/* =========================================================
 * 6. NHẬN TIN NHẮN DISCORD
 * ======================================================= */

discordClient.on(
  Events.MessageCreate,
  async (message) => {
    try {
      if (message.partial) {
        try {
          await message.fetch();
        } catch (error) {
          console.error(
            'Không fetch được partial message:',
            error.message,
          );

          return;
        }
      }

      console.log('');
      console.log(
        '===== CÓ TIN NHẮN DISCORD =====',
      );

      console.log(
        'Server ID:',
        message.guildId ?? 'DM',
      );

      console.log(
        'Channel ID:',
        message.channelId,
      );

      console.log(
        'Người gửi:',
        message.author.username,
      );

      console.log(
        'User ID:',
        message.author.id,
      );

      console.log(
        'Có phải bot:',
        message.author.bot,
      );

      console.log(
        'Nội dung gốc:',
        message.content,
      );

      console.log(
        'Số tệp:',
        message.attachments.size,
      );

      /*
       * Chặn tin nhắn do bot gửi,
       * tránh vòng lặp.
       */
      if (message.author.bot) {
        console.log(
          'Bỏ qua vì người gửi là bot.',
        );

        return;
      }

      const isDirectMessage =
        message.guildId === null;

      const mentionInfo =
        await detectBotMention(
          message,
        );

      const replyingToBot =
        await isReplyingToBot(
          message,
        );

      console.log(
        'Tag tài khoản bot:',
        mentionInfo.mentionedBotUser,
      );

      console.log(
        'Tag role bot:',
        mentionInfo.mentionedBotRole,
      );

      console.log(
        'Reply vào tin bot:',
        replyingToBot,
      );

      /*
       * DM luôn được xử lý.
       */
      if (isDirectMessage) {
        console.log(
          'Đây là DM → tiếp tục xử lý.',
        );
      }

      /*
       * Tin nhắn trong server.
       */
      if (!isDirectMessage) {
        /*
         * Kiểm tra server.
         */
        if (
          !isAllowedGuild(
            message.guildId,
          )
        ) {
          console.log(
            'Bỏ qua vì Server ID không nằm trong danh sách được phép:',
            message.guildId,
          );

          return;
        }

        /*
         * Kiểm tra channel.
         */
        if (
          !isAllowedChannel(
            message.channelId,
          )
        ) {
          console.log(
            'Bỏ qua vì Channel ID không nằm trong danh sách được phép:',
            message.channelId,
          );

          return;
        }

        /*
         * Nếu bắt buộc tag:
         * - tag tài khoản bot;
         * - tag role bot;
         * - hoặc reply tin của bot.
         */
        const botWasCalled =
          mentionInfo.mentionedBot ||
          replyingToBot;

        if (
          REQUIRE_MENTION_IN_GUILD &&
          !botWasCalled
        ) {
          console.log(
            'Bỏ qua vì chưa tag bot, chưa tag role bot và không reply tin bot.',
          );

          return;
        }
      }

      /*
       * Xóa mention bot trước khi gửi AI.
       */
      const cleanContent =
        removeBotMentions(
          message.content,
          discordClient.user.id,
          mentionInfo.botRoleIds,
        );

      console.log(
        'Nội dung sau khi xóa tag:',
        cleanContent,
      );

      /*
       * Không có nội dung và không có tệp.
       */
      if (
        !cleanContent &&
        message.attachments.size === 0
      ) {
        await message.reply(
          'Bạn hãy nhập nội dung cần hỏi nhé.',
        );

        return;
      }

      const attachments =
        extractAttachments(message);

      const payload = {
        id: String(
          message.id,
        ),

        guild_id: String(
          message.guildId ?? '',
        ),

        channel_id: String(
          message.channelId,
        ),

        content:
          cleanContent,

        timestamp:
          message.createdAt.toISOString(),

        author: {
          id: String(
            message.author.id,
          ),

          username: String(
            message.author.username ??
            '',
          ),

          global_name: String(
            message.author.globalName ??
            '',
          ),

          bot: Boolean(
            message.author.bot,
          ),
        },

        member: {
          nick: String(
            message.member?.nickname ??
            '',
          ),

          display_name: String(
            message.member?.displayName ??
            message.author.globalName ??
            message.author.username ??
            '',
          ),
        },

        attachments,

        mentions: [
          ...message.mentions.users.values(),
        ].map((user) => ({
          id: String(
            user.id,
          ),

          username: String(
            user.username ?? '',
          ),

          bot: Boolean(
            user.bot,
          ),
        })),

        mentioned_roles: [
          ...message.mentions.roles.values(),
        ].map((role) => ({
          id: String(
            role.id,
          ),

          name: String(
            role.name ?? '',
          ),
        })),

        metadata: {
          mentioned_bot:
            mentionInfo.mentionedBot,

          mentioned_bot_user:
            mentionInfo.mentionedBotUser,

          mentioned_bot_role:
            mentionInfo.mentionedBotRole,

          replied_to_bot:
            replyingToBot,

          is_direct_message:
            isDirectMessage,

          source:
            'discord-gateway-render',
        },
      };

      console.log(
        'Đang gửi sang n8n:',
        N8N_WEBHOOK_URL,
      );

      const result =
        await sendToN8n(
          payload,
        );

      if (!result.ok) {
        console.error(
          'n8n trả về lỗi:',
          result.status,
          result.responseText,
        );

        if (
          result.status === 404 ||
          result.status >= 500
        ) {
          await message.reply(
            'Trợ lý đang gặp lỗi khi xử lý. Bạn thử lại sau nhé.',
          );
        }

        return;
      }

      console.log(
        'Đã gửi tin sang n8n thành công:',
        {
          messageId:
            message.id,

          status:
            result.status,

          response:
            result.responseText,
        },
      );
    } catch (error) {
      if (
        error?.name ===
        'AbortError'
      ) {
        console.error(
          'n8n phản hồi quá thời gian.',
        );

        try {
          await message.reply(
            'Hệ thống xử lý hơi lâu. Bạn thử lại sau nhé.',
          );
        } catch {
          // Không làm gì thêm.
        }

        return;
      }

      console.error(
        'Lỗi khi xử lý tin Discord:',
        error,
      );
    }
  },
);

/* =========================================================
 * 7. WEB SERVER CHO RENDER
 * ======================================================= */

const app = express();

app.disable(
  'x-powered-by',
);

app.get(
  '/',
  (request, response) => {
    response.status(200).json({
      status:
        'running',

      service:
        'discord-n8n-bot',

      discord_ready:
        discordClient.isReady(),

      bot_user_id:
        discordClient.user?.id ??
        null,

      bot_tag:
        discordClient.user?.tag ??
        null,
    });
  },
);

app.get(
  '/health',
  (request, response) => {
    response.status(200).json({
      status:
        'healthy',

      discord_ready:
        discordClient.isReady(),

      bot_user_id:
        discordClient.user?.id ??
        null,

      bot_tag:
        discordClient.user?.tag ??
        null,

      guild_filters:
        DISCORD_GUILD_IDS,

      channel_filters:
        DISCORD_CHANNEL_IDS,

      require_mention_in_guild:
        REQUIRE_MENTION_IN_GUILD,

      allow_reply_to_bot:
        ALLOW_REPLY_TO_BOT,

      webhook_configured:
        Boolean(
          N8N_WEBHOOK_URL,
        ),
    });
  },
);

const port =
  Number(
    process.env.PORT,
  ) || 10000;

app.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `Web server đang chạy tại port ${port}`,
    );
  },
);

/* =========================================================
 * 8. ĐĂNG NHẬP BOT DISCORD
 * ======================================================= */

discordClient
  .login(
    DISCORD_TOKEN,
  )
  .catch((error) => {
    console.error(
      'Không đăng nhập được Discord:',
      error,
    );

    process.exit(1);
  });
