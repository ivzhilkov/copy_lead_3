export interface AuthCallbackQuery {
  code: string;
  state: string;
  referer: string;
  client_id: string;
}
