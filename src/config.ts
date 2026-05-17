export const config = () => ({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI,
  widgetCode: process.env.WIDGET_CODE,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  adminToken: process.env.ADMIN_TOKEN,
  adminLogin: process.env.ADMIN_LOGIN,
  adminPassword: process.env.ADMIN_PASSWORD,
  dadataApiKey: process.env.DADATA_API_KEY,
  dadataSecretKey: process.env.DADATA_SECRET_KEY,
});
