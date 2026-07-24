const express = require('express');

const {
  Client,
  GatewayIntentBits,
  Events,
} = require('discord.js');

/* =========================================================
 * 1. KIỂM TRA BIẾN MÔI TRƯỜNG
 * ======================================================= */

const requiredVariables = [
  'DISCORD_TOKEN',
  'N8N_WEBHOOK_URL',
  'DISCORD_GUILD_ID',
  'DISCORD_CHANNEL_ID',
];

const missingVariables =
  requiredVariables.filter((name) => {
    return !process.env[name];
  });

if (missingVariables.length > 0) {
  console.error(
    'Thiếu biến môi trường:',
    missingVariables.join(', '),
  );

  process.exit(1);
}

/* =========================================================
 * 2. KHỞI TẠO DISCORD BOT
 * ======================================================= */

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

discordClient.once(
  Events.ClientReady,
  (client) => {
    console.log(
      `Bot Discord đã online: ${client.user.tag}`,
    );
  },
);

/* =========================================================
 * 3. NHẬN TIN NHẮN MỚI TỪ DISCORD
 * ======================================================= */

discordClient.on(
  Events.MessageCreate,
  async (message) => {
    try {
      /*
       * Không xử lý tin do bot gửi.
       */
      if (message.author.bot) {
        return;
      }

      /*
       * Chỉ xử lý tin trong server WEHA TECH.
       */
      if (
        message.guildId !==
        process.env.DISCORD_GUILD_ID
      ) {
        return;
      }

      /*
       * Chỉ xử lý kênh check-in-out.
       */
      if (
        message.channelId !==
        process.env.DISCORD_CHANNEL_ID
      ) {
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
        size:
          attachment.size || 0,
      }));

      /*
       * Dữ liệu gửi sang n8n.
       */
      const payload = {
        id: message.id,

        guild_id:
          message.guildId,

        channel_id:
          message.channelId,

        content:
          message.content,

        timestamp:
          message.createdAt.toISOString(),

        author: {
          id:
            message.author.id,

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
      };

      const response = await fetch(
        process.env.N8N_WEBHOOK_URL,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',
          },

          body:
            JSON.stringify(payload),
        },
      );

      const responseText =
        await response.text();

      if (!response.ok) {
        console.error(
          'n8n trả về lỗi:',
          response.status,
          responseText,
        );

        return;
      }

      console.log(
        'Đã gửi tin sang n8n:',
        message.id,
        response.status,
      );
    } catch (error) {
      console.error(
        'Lỗi khi xử lý tin Discord:',
        error,
      );
    }
  },
);

/* =========================================================
 * 4. TẠO WEB SERVER CHO RENDER
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

app.get(
  '/health',
  (request, response) => {
    response.status(200).json({
      status: 'healthy',

      discord_ready:
        discordClient.isReady(),
    });
  },
);

const port =
  Number(process.env.PORT) ||
  10000;

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
 * 5. ĐĂNG NHẬP BOT VÀO DISCORD
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
