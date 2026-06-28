export interface NotifyResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface WhatsAppTemplate {
  name: string;
  language: string; // e.g. 'en'
  params: string[]; // ordered body {{1}}, {{2}}, ...
}

/**
 * Notification primitive. The parked anomaly/alert layer (Module B) calls this;
 * the concrete is the in-house WhatsApp notifier (Meta Cloud API direct, no BSP).
 */
export interface NotificationPort {
  sendText(to: string, body: string): Promise<NotifyResult>;
  sendTemplate(to: string, template: WhatsAppTemplate): Promise<NotifyResult>;
}
