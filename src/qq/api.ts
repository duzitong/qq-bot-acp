const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE_URL = "https://api.sgroup.qq.com";

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
}

interface GatewayResponse {
  url?: string;
}

export class QQApi {
  private accessToken?: string;
  private tokenExpiresAt = 0;

  constructor(
    readonly appId: string,
    private readonly clientSecret: string,
  ) {}

  async getAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });
    const body = (await response.json()) as TokenResponse;
    if (!response.ok || !body.access_token) {
      throw new Error(`QQ authentication failed (${response.status}): ${JSON.stringify(body)}`);
    }
    const expiresIn = Number(body.expires_in ?? 7200);
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
    return this.accessToken;
  }

  async getGatewayUrl(): Promise<string> {
    const response = await this.request("/gateway", { method: "GET" });
    const body = (await response.json()) as GatewayResponse;
    if (!body.url) throw new Error("QQ gateway response did not include a WebSocket URL");
    return body.url;
  }

  async sendText(input: {
    chatType: "direct" | "group" | "channel";
    targetId: string;
    text: string;
    replyToId?: string;
    sequence?: number;
  }): Promise<string | undefined> {
    const body =
      input.chatType === "channel"
        ? { content: input.text, msg_id: input.replyToId }
        : {
            content: input.text,
            msg_type: 0,
            msg_id: input.replyToId,
            msg_seq: input.sequence ?? 1,
          };
    const endpoint =
      input.chatType === "direct"
        ? `/v2/users/${encodeURIComponent(input.targetId)}/messages`
        : input.chatType === "group"
          ? `/v2/groups/${encodeURIComponent(input.targetId)}/messages`
          : `/channels/${encodeURIComponent(input.targetId)}/messages`;
    const response = await this.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!response.ok) {
      throw new Error(`QQ send failed (${response.status}): ${JSON.stringify(result)}`);
    }
    return result.id;
  }

  private async request(endpoint: string, init: RequestInit, retry = true): Promise<Response> {
    const token = await this.getAccessToken();
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `QQBot ${token}`,
        "x-union-appid": this.appId,
      },
    });
    if (response.status === 401 && retry) {
      await this.getAccessToken(true);
      return this.request(endpoint, init, false);
    }
    return response;
  }
}
