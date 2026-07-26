const express = require('express');

const {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
} = require('discord.js');

/* =========================================================
 * 1. KIỂM TRA BIẾN MÔI TRƯỜNG BẮT BUỘC
 * ======================================================= */

const requiredVariables = [
  'DISCORD_TOKEN',
  'N8N_WEBHOOK_URL',
];

const missingVariables = requiredVariables.filter(
  (name) => !process.env[name],
);

if (missingVariables.length > 0) {
  console.error(
    'Thiếu biến môi trường:',
    missingVariables.join(', '),
  );

  process.exit(1);
}

/*
 * Hai biến dưới đây là tùy chọn.
 *
 * Có DISCORD_GUILD_ID:
 * Bot chỉ xử lý tin trong server đó.
 *
 * Có DISCORD_CHANNEL_ID:
 * Bot chỉ xử lý tin trong kênh đó.
 *
 * Không có:
 * Bot không bị lỗi undefined.
 */
const DISCORD_GUILD_ID =
  process.env.DISCORD_GUILD_ID?.trim() || '';

const DISCORD_CHANNEL_ID =
  process.env.DISCORD_CHANNEL_ID?.trim() || '';

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL.trim();

/* =========================================================
 * 2. KHỞI TẠO DISCORD BOT
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
  ],
});

/* =========================================================
 * 3. BOT ONLINE
 * ======================================================= */

discordClient.once(
  Events.ClientReady,
  async (client) => {
    console.log('====================================');
    console.log(`Bot Discord đã online: ${client.user.tag}`);
    console.log(`Bot User ID: ${client.user.id}`);
    console.log(
      `Số server bot nhìn thấy: ${client.guilds.cache.size}`,
    );

    console.log(
      'Danh sách server:',
      client.guilds.cache.map(
        (guild) => `${guild.name} | ${guild.id}`,
      ),
    );

    if (DISCORD_GUILD_ID) {
      const targetGuild =
        client.guilds.cache.get(DISCORD_GUILD_ID);

      if (!targetGuild) {
        console.warn(
          'Không tìm thấy server đã cấu hình:',
          DISCORD_GUILD_ID,
        );
      } else {
        console.log(
          'Đã tìm thấy server:',
          targetGuild.name,
          targetGuild.id,
        );
      }
    } else {
      console.log(
        'Không cấu hình DISCORD_GUILD_ID → không giới hạn server.',
      );
    }

    if (DISCORD_CHANNEL_ID) {
      try {
        const targetChannel =
          await client.channels.fetch(
            DISCORD_CHANNEL_ID,
          );

        if (!targetChannel) {
          console.warn(
            'Không tìm thấy kênh:',
            DISCORD_CHANNEL_ID,
          );
        } else {
          console.log(
            'Đã tìm thấy kênh:',
            targetChannel.name ?? 'Không có tên',
            targetChannel.id,
          );
        }
      } catch (error) {
        console.error(
          'Bot không truy cập được kênh:',
          error.message,
        );
      }
    } else {
      console.log(
        'Không cấu hình DISCORD_CHANNEL_ID → chỉ nhận DM hoặc tin nhắn tag trực tiếp bot.',
      );
    }

    console.log('====================================');
  },
);

/* =========================================================
 * 4. NHẬN TIN NHẮN TỪ DISCORD
 * ======================================================= */

discordClient.on(
  Events.MessageCreate,
  async (message) => {
    try {
      console.log('===== CÓ TIN NHẮN DISCORD =====');
      console.log('Server ID:', message.guildId ?? 'DM');
      console.log('Channel ID:', message.channelId);
      console.log('Người gửi:', message.author.username);
      console.log('Có phải bot:', message.author.bot);
      console.log('Nội dung:', message.content);
      console.log('Số tệp:', message.attachments.size);

      /*
       * Chặn tin nhắn do bot gửi để tránh vòng lặp.
       */
      if (message.author.bot) {
        console.log('Bỏ qua vì người gửi là bot.');
        return;
      }

      const isDirectMessage = !message.guildId;

      const mentionedBot =
        message.mentions.users.has(
          discordClient.user.id,
        );

      /*
       * Nếu có cấu hình server thì chỉ nhận đúng server đó.
       * Tin nhắn DM vẫn được phép.
       */
      if (
        DISCORD_GUILD_ID &&
        !isDirectMessage &&
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

      /*
       * Nếu có cấu hình channel thì chỉ nhận đúng channel đó.
       * Tin nhắn DM vẫn được phép.
       */
      if (
        DISCORD_CHANNEL_ID &&
        !isDirectMessage &&
        message.channelId !== DISCORD_CHANNEL_ID
      ) {
        console.log(
          'Bỏ qua vì sai Channel ID:',
          message.channelId,
          '!=',
          DISCORD_CHANNEL_ID,
        );

        return;
      }

      /*
       * Nếu KHÔNG cấu hình channel:
       * - DM: nhận mọi tin
       * - Trong server: chỉ nhận khi tag trực tiếp bot
       */
      if (
        !DISCORD_CHANNEL_ID &&
        !isDirectMessage &&
        !mentionedBot
      ) {
        console.log(
          'Bỏ qua vì chưa tag trực tiếp bot.',
        );

        return;
      }

      /*
       * Xóa mention trực tiếp của bot khỏi nội dung.
       */
      const cleanContent = message.content
        .replace(
          new RegExp(
            `<@!?${discordClient.user.id}>`,
            'g',
          ),
          '',
        )
        .trim();

      if (
        !cleanContent &&
        message.attachments.size === 0
      ) {
        await message.reply(
          'Bạn hãy nhập nội dung cần hỏi nhé.',
        );

        return;
      }

      const attachments = [
        ...message.attachments.values(),
      ].map((attachment) => ({
        id: attachment.id,
        name: attachment.name || '',
        url: attachment.url,
        content_type:
          attachment.contentType || '',
        size: attachment.size || 0,
      }));

      /*
       * Payload giữ đúng cấu trúc mà 03_PARSE_DISCORD đọc.
       */
      const payload = {
        id: message.id,

        guild_id:
          message.guildId || '',

        channel_id:
          message.channelId,

        content:
          cleanContent,

        timestamp:
          message.createdAt.toISOString(),

        author: {
          id: message.author.id,
          username:
            message.author.username,
          global_name:
            message.author.globalName || '',
          bot:
            message.author.bot,
        },

        member: {
          nick:
            message.member?.nickname || '',

          display_name:
            message.member?.displayName || '',
        },

        attachments,

        metadata: {
          mentioned_bot: mentionedBot,
          is_direct_message: isDirectMessage,
        },
      };

      console.log(
        'Đang gửi sang n8n:',
        N8N_WEBHOOK_URL,
      );

      /*
       * Giới hạn thời gian chờ n8n là 120 giây.
       */
      const controller =
        new AbortController();

      const timeout = setTimeout(
        () => controller.abort(),
        120000,
      );

      let response;

      try {
        response = await fetch(
          N8N_WEBHOOK_URL,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body:
              JSON.stringify(payload),

            signal:
              controller.signal,
          },
        );
      } finally {
        clearTimeout(timeout);
      }

      const responseText =
        await response.text();

      if (!response.ok) {
        console.error(
          'n8n trả về lỗi:',
          response.status,
          responseText,
        );

        await message.reply(
          'Trợ lý đang gặp lỗi khi xử lý. Bạn thử lại sau nhé.',
        );

        return;
      }

      console.log(
        'Đã gửi tin sang n8n:',
        message.id,
        response.status,
        responseText,
      );

      /*
       * Workflow n8n hiện tự gửi câu trả lời qua Discord API,
       * nên bot Render không gửi thêm lần nữa.
       */
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(
          'n8n phản hồi quá thời gian cho phép.',
        );

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
 * 5. WEB SERVER CHO RENDER
 * ======================================================= */

const app = express();

app.get('/', (request, response) => {
  response.status(200).json({
    status: 'running',
    service: 'discord-n8n-bot',
    discord_ready:
      discordClient.isReady(),
  });
});

app.get('/health', (request, response) => {
  response.status(200).json({
    status: 'healthy',
    discord_ready:
      discordClient.isReady(),
    guild_filter:
      DISCORD_GUILD_ID || null,
    channel_filter:
      DISCORD_CHANNEL_ID || null,
  });
});

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
 * 6. ĐĂNG NHẬP DISCORD
 * ======================================================= */

discordClient
  .login(process.env.DISCORD_TOKEN)
  .catch((error) => {
    console.error(
      'Không đăng nhập được Discord:',
      error,
    );

    process.exit(1);
  });
