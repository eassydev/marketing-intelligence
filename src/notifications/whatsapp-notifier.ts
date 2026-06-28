import { env } from '../config/env.js';
import { createChildLogger } from '../shared/logger/index.js';
import { assertAllowed } from './allowlist.js';
import type { NotificationPort, NotifyResult, WhatsAppTemplate } from './port.js';

const log = createChildLogger({ module: 'whatsapp' });

/**
 * In-house WhatsApp via Meta Cloud API (no BSP). Business-initiated alerts must
 * use an approved template (sendTemplate); sendText only works inside a 24h
 * session window. Recipients are allowlisted.
 */
export class WhatsAppNotifier implements NotificationPort {
  private endpoint(): string {
    return `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  }

  async sendText(to: string, body: string): Promise<NotifyResult> {
    assertAllowed(to);
    return this.send({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
  }

  async sendTemplate(to: string, t: WhatsAppTemplate): Promise<NotifyResult> {
    assertAllowed(to);
    return this.send({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: t.name,
        language: { code: t.language },
        components: [
          { type: 'body', parameters: t.params.map((text) => ({ type: 'text', text })) },
        ],
      },
    });
  }

  private async send(payload: Record<string, unknown>): Promise<NotifyResult> {
    if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
      return { success: false, error: 'WhatsApp not configured' };
    }
    try {
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        log.error({ status: res.status, body: text.slice(0, 300) }, 'WhatsApp send failed');
        return { success: false, error: `WhatsApp ${res.status}` };
      }
      const data = (await res.json()) as { messages?: Array<{ id?: string }> };
      return { success: true, providerMessageId: data.messages?.[0]?.id };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}
