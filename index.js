'use strict';

const express = require('express');

const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

/* =========================================================
 * 1. BIẾN MÔI TRƯỜNG
 * ======================================================= */

const requiredVariables = [
  'DISCORD_TOKEN',
  'N8N_WEBHOOK_URL',
];

const missingVariables = requiredVariables.filter(
  (name) => !String(process.env[name] ?? '').trim(),
);

if (missingVariables.length > 0) {
  console.error(
    'Thiếu biến môi trường bắt buộc:',
    missingVariables.join(', '),
  );

  process.exit(1);
}

const DISCORD_TOKEN =
  process.env.DISCORD_TOKEN.trim();

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL.trim();

/*
 * Hai biến này không bắt buộc.
 *
 * Khi có giá trị:
 * - Giới hạn bot trong đúng server/kênh đó.
 *
 * Tin nhắn DM không bị ảnh hưởng bởi hai biến này.
 */
const DISCORD_GUILD_ID =
  String(process.env.DISCORD_GUILD_ID ?? '').trim();

const DISCORD_CHANNEL_ID =
  String(process.env.DISCORD_CHANNEL_ID ?? '').trim();

/*
 * Trong server:
 * true  = chỉ xử lý khi tag trực tiếp bot.
 * false = xử lý mọi tin trong channel được phép.
 *
 * Mặc định là true.
 */
const REQUIRE_MENTION_IN_GUILD =
  String(
    process.env.REQUIRE_MENTION_IN_GUILD ?? 'true',
  ).toLowerCase() !== 'false';

/*
 * Thời gian tối đa chờ workflow n8n.
 */
const N8N_TIMEOUT_MS = 120000;

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
 * 3. BOT SẴN SÀNG
 * ======================================================= */

discordClient.once(
  Events.ClientReady,
  async (client) => {
    console.log('====================================');
    console.log(`Bot đã online: ${client.user.tag}`);
    console.log(`Bot User ID: ${client.user.id}`);
    console.log(
      `Số server nhìn thấy: ${client.guilds.cache.size}`,
    );

    console.log(
      'Danh sách server:',
      client.guilds.cache.map(
        (guild) => `${guild.name} | ${guild.id}`,
      ),
    );

    if (DISCORD_GUILD_ID) {
      const guild =
        client.guilds.cache.get(DISCORD_GUILD_ID);

      if (guild) {
        console.log(
          `Đã tìm thấy server: ${guild.name} | ${guild.id}`,
        );
      } else {
        console.warn(
          'Không tìm thấy server đã cấu hình:',
          DISCORD_GUILD_ID,
        );
      }
    } else {
      console.log(
        'Không giới hạn server bằng DISCORD_GUILD_ID.',
      );
    }

    if (DISCORD_CHANNEL_ID) {
      try {
        const channel =
          await client.channels.fetch(
            DISCORD_CHANNEL_ID,
          );

        if (channel) {
          console.log(
            `Đã tìm thấy kênh: ${
              channel.name ?? 'Không có tên'
            } | ${channel.id}`,
          );
        } else {
          console.warn(
            'Không tìm thấy channel đã cấu hình:',
            DISCORD_CHANNEL_ID,
          );
        }
      } catch (error) {
        console.error(
          'Không truy cập được channel:',
          error.message,
        );
      }
    } else {
      console.log(
        'Không giới hạn channel bằng DISCORD_CHANNEL_ID.',
      );
    }

    console.log(
      'Bắt buộc tag bot trong server:',
      REQUIRE_MENTION_IN_GUILD,
    );

    console.log('N8N Webhook:', N8N_WEBHOOK_URL);
    console.log('====================================');
  },
);

/* =========================================================
 * 4. HÀM XÓA TAG BOT KHỎI NỘI DUNG
 * ======================================================= */

function removeBotMention(content, botUserId) {
  return String(content ?? '')
    .replace(
      new RegExp(`<@!?${botUserId}>`, 'g'),
      '',
    )
    .trim();
}

/* =========================================================
 * 5. HÀM CHUYỂN ATTACHMENT
 * ======================================================= */

function extractAttachments(message) {
  return [
    ...message.attachments.values(),
  ].map((attachment) => ({
    id: String(attachment.id),
    name: String(attachment.name ?? ''),
    url: String(attachment.url ?? ''),
    proxy_url: String(
      attachment.proxyURL ?? '',
    ),
    content_type: String(
      attachment.contentType ?? '',
    ),
    size: Number(attachment.size ?? 0),
    width:
      attachment.width === null
        ? null
        : Number(attachment.width),
    height:
      attachment.height === null
        ? null
        : Number(attachment.height),
  }));
}

/* =========================================================
 * 6. GỬI PAYLOAD SANG N8N
 * ======================================================= */

async function sendToN8n(payload) {
  const controller = new AbortController();

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
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },

        body: JSON.stringify(payload),

        signal: controller.signal,
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
 * 7. NHẬN TIN NHẮN DISCORD
 * ======================================================= */

discordClient.on(
  Events.MessageCreate,
  async (message) => {
    try {
      /*
       * Với một số DM partial, cần fetch đầy đủ message.
       */
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
      console.log('===== CÓ TIN NHẮN DISCORD =====');
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
        'Nội dung:',
        message.content,
      );
      console.log(
        'Số tệp:',
        message.attachments.size,
      );

      /*
       * Bắt buộc giữ điều kiện này.
       * Nếu bỏ, bot sẽ đọc câu trả lời của chính nó
       * và tạo vòng lặp vô hạn.
       */
      if (message.author.bot) {
        console.log(
          'Bỏ qua vì người gửi là bot.',
        );

        return;
      }

      const isDirectMessage =
        message.guildId === null;

      const mentionedBot =
        Boolean(
          discordClient.user &&
          message.mentions.users.has(
            discordClient.user.id,
          ),
        );

      /*
       * TIN NHẮN DM:
       * Luôn xử lý tất cả tin của người dùng.
       */
      if (isDirectMessage) {
        console.log(
          'Đây là tin nhắn DM → tiếp tục xử lý.',
        );
      }

      /*
       * TIN TRONG SERVER:
       * Kiểm tra server, channel và mention.
       */
      if (!isDirectMessage) {
        if (
          DISCORD_GUILD_ID &&
          message.guildId !== DISCORD_GUILD_ID
        ) {
          console.log(
            'Bỏ qua vì sai Server ID:',
            message.guildId,
            '!=',
            DISCORD_GUILD_ID,
          );

          return;
        }

        if (
          DISCORD_CHANNEL_ID &&
          message.channelId !==
            DISCORD_CHANNEL_ID
        ) {
          console.log(
            'Bỏ qua vì sai Channel ID:',
            message.channelId,
            '!=',
            DISCORD_CHANNEL_ID,
          );

          return;
        }

        if (
          REQUIRE_MENTION_IN_GUILD &&
          !mentionedBot
        ) {
          console.log(
            'Bỏ qua vì chưa tag trực tiếp bot.',
          );

          return;
        }
      }

      const cleanContent =
        removeBotMention(
          message.content,
          discordClient.user.id,
        );

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

      /*
       * Payload khớp với node 03_PARSE_DISCORD.
       */
      const payload = {
        id: String(message.id),

        guild_id: String(
          message.guildId ?? '',
        ),

        channel_id: String(
          message.channelId,
        ),

        content: cleanContent,

        timestamp:
          message.createdAt.toISOString(),

        author: {
          id: String(message.author.id),

          username: String(
            message.author.username ?? '',
          ),

          global_name: String(
            message.author.globalName ?? '',
          ),

          bot: Boolean(
            message.author.bot,
          ),
        },

        member: {
          nick: String(
            message.member?.nickname ?? '',
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
          id: String(user.id),
          username: String(
            user.username ?? '',
          ),
          bot: Boolean(user.bot),
        })),

        metadata: {
          mentioned_bot: mentionedBot,
          is_direct_message:
            isDirectMessage,

          source: 'discord-gateway-render',
        },
      };

      console.log(
        'Đang gửi sang n8n:',
        N8N_WEBHOOK_URL,
      );

      const result =
        await sendToN8n(payload);

      if (!result.ok) {
        console.error(
          'n8n trả về lỗi:',
          result.status,
          result.responseText,
        );

        /*
         * Tránh Discord reply nhiều lần nếu n8n
         * đã gửi được tin nhưng Respond to Webhook lỗi.
         */
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
          messageId: message.id,
          status: result.status,
          response: result.responseText,
        },
      );

      /*
       * Không reply tại Render.
       *
       * Workflow n8n hiện có HTTP Request gửi
       * câu trả lời trực tiếp lên Discord.
       *
       * Nếu Render reply thêm ở đây,
       * người dùng sẽ nhận hai câu trả lời.
       */
    } catch (error) {
      if (error?.name === 'AbortError') {
        console.error(
          'n8n phản hồi quá thời gian.',
        );

        try {
          await message.reply(
            'Hệ thống xử lý quá lâu. Bạn thử lại sau nhé.',
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
 * 8. WEB SERVER CHO RENDER
 * ======================================================= */

const app = express();

app.disable('x-powered-by');

app.get('/', (request, response) => {
  response.status(200).json({
    status: 'running',
    service: 'discord-n8n-bot',
    discord_ready:
      discordClient.isReady(),
  });
});

app.get(
  '/health',
  (request, response) => {
    response.status(200).json({
      status: 'healthy',

      discord_ready:
        discordClient.isReady(),

      bot_user_id:
        discordClient.user?.id ?? null,

      bot_tag:
        discordClient.user?.tag ?? null,

      guild_filter:
        DISCORD_GUILD_ID || null,

      channel_filter:
        DISCORD_CHANNEL_ID || null,

      require_mention_in_guild:
        REQUIRE_MENTION_IN_GUILD,

      webhook_configured:
        Boolean(N8N_WEBHOOK_URL),
    });
  },
);

const port =
  Number(process.env.PORT) || 10000;

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
 * 9. ĐĂNG NHẬP DISCORD
 * ======================================================= */

discordClient
  .login(DISCORD_TOKEN)
  .catch((error) => {
    console.error(
      'Không đăng nhập được Discord:',
      error,
    );

    process.exit(1);
  });
