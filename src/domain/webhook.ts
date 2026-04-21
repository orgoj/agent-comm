import { createHmac } from 'crypto';
import { request as httpReq } from 'http';
import { request as httpsReq } from 'https';
import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { Message, WebhookSubscription } from '../types.js';

interface WebhookRow {
  agent_id: string;
  url: string;
  secret: string;
  events: string;
  created_at: string;
}

function rowToSub(row: WebhookRow): WebhookSubscription {
  return {
    agent_id: row.agent_id,
    url: row.url,
    secret: row.secret,
    events: JSON.parse(row.events),
    created_at: row.created_at,
  };
}

function stripSecret(
  sub: WebhookSubscription,
): Omit<WebhookSubscription, 'secret'> & { secret?: never } {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret: _, ...rest } = sub;
  return rest;
}

export { stripSecret };

export function validateWebhookUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return 'URL must use http:// or https://';
    }
    if (!u.hostname) return 'URL must have a hostname';
    if (url.length > 2048) return 'URL too long (max 2048 chars)';
    return null;
  } catch {
    return 'Invalid URL format';
  }
}

export class WebhookService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {
    this.events.on('message:sent', (event) => {
      this.onMessage(event.data.message as Message);
    });
  }

  register(agentId: string, url: string, secret: string, events?: string[]): WebhookSubscription {
    const evts = events ?? ['message:sent'];
    this.db.run(
      `INSERT INTO webhooks (agent_id, url, secret, events) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET url = excluded.url, secret = excluded.secret, events = excluded.events`,
      [agentId, url, secret, JSON.stringify(evts)],
    );
    return this.getForAgent(agentId)!;
  }

  unregister(agentId: string): boolean {
    const r = this.db.run(`DELETE FROM webhooks WHERE agent_id = ?`, [agentId]);
    return r.changes > 0;
  }

  list(): WebhookSubscription[] {
    return this.db.queryAll<WebhookRow>(`SELECT * FROM webhooks`).map(rowToSub);
  }

  getForAgent(agentId: string): WebhookSubscription | null {
    const row = this.db.queryOne<WebhookRow>(`SELECT * FROM webhooks WHERE agent_id = ?`, [
      agentId,
    ]);
    return row ? rowToSub(row) : null;
  }

  private onMessage(message: Message): void {
    const targets: string[] = [];

    if (message.to_agent) {
      targets.push(message.to_agent);
    }

    if (message.channel_id) {
      const members = this.db.queryAll<{ agent_id: string }>(
        `SELECT agent_id FROM channel_members WHERE channel_id = ?`,
        [message.channel_id],
      );
      for (const m of members) {
        if (!targets.includes(m.agent_id)) targets.push(m.agent_id);
      }
    }

    for (const agentId of targets) {
      if (agentId === message.from_agent) continue;
      const sub = this.getForAgent(agentId);
      if (sub && sub.events.includes('message:sent')) {
        this.deliver(sub, message);
      }
    }
  }

  private deliver(sub: WebhookSubscription, message: Message): void {
    const payload = JSON.stringify({
      event: 'message:sent',
      timestamp: new Date().toISOString(),
      data: {
        id: message.id,
        from_agent: message.from_agent,
        to_agent: message.to_agent,
        channel_id: message.channel_id,
        content: message.content,
        importance: message.importance,
        created_at: message.created_at,
      },
    });

    const sig = createHmac('sha256', sub.secret).update(payload).digest('hex');

    try {
      const u = new URL(sub.url);
      const isHttps = u.protocol === 'https:';
      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Comm-Signature': `sha256=${sig}`,
        },
        timeout: 5000,
      };

      const req = (isHttps ? httpsReq : httpReq)(opts, (res) => {
        res.resume();
      });
      req.on('error', (err) => {
        process.stderr.write(
          `[agent-comm] Webhook delivery failed for ${sub.agent_id}: ${err.message}\n`,
        );
      });
      req.on('timeout', () => {
        process.stderr.write(
          `[agent-comm] Webhook delivery timed out for ${sub.agent_id} → ${sub.url}\n`,
        );
        req.destroy();
      });
      req.write(payload);
      req.end();
    } catch (err) {
      process.stderr.write(
        `[agent-comm] Webhook delivery error for ${sub.agent_id}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
