// In-memory state for the demo. No database — everything lives in this process
// and resets when you restart the server.
//
// Holds: per-lead conversation state, the tunable humanization config, and a
// rolling event log that the control panel streams over SSE.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/** Normalize a WhatsApp address to bare E.164, e.g. "whatsapp:+15551234567" -> "+15551234567". */
export function normalizeNumber(raw) {
  if (!raw) return '';
  let n = String(raw).trim();
  n = n.replace(/^whatsapp:/i, '');
  n = n.replace(/[\s()-]/g, '');
  if (!n.startsWith('+')) n = '+' + n;
  return n;
}

class Store extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Lead>} keyed by normalized number */
    this.leads = new Map();
    /** @type {LogEvent[]} newest last */
    this.log = [];
    this.logSeq = 0;

    this.config = {
      debounceMs: intEnv('DEBOUNCE_MS', 8000),
      splitMessages: boolEnv('SPLIT_MESSAGES', true),
      typingMinMs: intEnv('TYPING_MIN_MS', 1500),
      typingPerCharMs: intEnv('TYPING_PER_CHAR_MS', 35),
      typingMaxMs: intEnv('TYPING_MAX_MS', 9000),
    };

    this.loadLeads();
  }

  getConfig() {
    return { ...this.config };
  }

  setConfig(partial) {
    // Only accept known, sane keys.
    if (typeof partial.debounceMs === 'number' && partial.debounceMs >= 0) {
      this.config.debounceMs = Math.round(partial.debounceMs);
    }
    if (typeof partial.splitMessages === 'boolean') {
      this.config.splitMessages = partial.splitMessages;
    }
    this.emit('config', this.getConfig());
    this.addLog({
      type: 'system',
      text: `config updated → debounce=${this.config.debounceMs}ms, split=${this.config.splitMessages}`,
    });
    return this.getConfig();
  }

  loadLeads() {
    try {
      const dbPath = path.join(process.cwd(), 'leads.json');
      if (fs.existsSync(dbPath)) {
        const raw = fs.readFileSync(dbPath, 'utf8');
        const data = JSON.parse(raw);
        for (const [key, lead] of Object.entries(data)) {
          if (lead.active === undefined) lead.active = true;
          this.leads.set(key, lead);
        }
      }
    } catch (err) {
      console.error('Failed to load leads.json:', err);
    }
  }

  saveLeads() {
    try {
      const dbPath = path.join(process.cwd(), 'leads.json');
      const obj = Object.fromEntries(this.leads.entries());
      fs.writeFileSync(dbPath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save leads.json:', err);
    }
  }

  getOrCreateLead(number, { name = '', interest = '' } = {}) {
    const key = normalizeNumber(number);
    let lead = this.leads.get(key);
    if (!lead) {
      lead = {
        id: key,
        number: key,
        name: name || '',
        interest: interest || '',
        history: [], // [{role:'user'|'assistant', content}]
        active: true,
        createdAt: Date.now(),
      };
      this.leads.set(key, lead);
      this.saveLeads();
      this.emit('leads', this.listLeads());
    } else {
      // Enrich an existing lead if the form gave us new info.
      let changed = false;
      if (name && !lead.name) {
        lead.name = name;
        changed = true;
      }
      if (interest && !lead.interest) {
        lead.interest = interest;
        changed = true;
      }
      if (changed) {
        this.saveLeads();
        this.emit('leads', this.listLeads());
      }
    }
    return lead;
  }

  getLead(number) {
    return this.leads.get(normalizeNumber(number));
  }

  listLeads() {
    return [...this.leads.values()].map((l) => ({
      id: l.id,
      number: l.number,
      name: l.name,
      interest: l.interest,
      turns: l.history.length,
      active: l.active !== false,
      createdAt: l.createdAt,
    }));
  }

  appendHistory(number, role, content) {
    const lead = this.getLead(number);
    if (!lead) return;
    lead.history.push({ role, content });
    this.saveLeads();
    this.emit('leads', this.listLeads());
  }

  toggleLeadActive(number, active) {
    const lead = this.getLead(number);
    if (!lead) return null;
    lead.active = !!active;
    this.saveLeads();
    this.emit('leads', this.listLeads());
    this.addLog({
      type: 'system',
      leadId: lead.id,
      name: lead.name,
      text: `lead ${lead.name || lead.id} AI conversation ${lead.active ? 'activated' : 'paused'}`,
    });
    return lead;
  }

  /**
   * Record an event for the live log.
   * @param {{type:string, leadId?:string, name?:string, number?:string, direction?:string, text?:string, meta?:object}} e
   */
  addLog(e) {
    const event = {
      seq: ++this.logSeq,
      ts: Date.now(),
      ...e,
    };
    this.log.push(event);
    if (this.log.length > 500) this.log.shift();
    this.emit('log', event);
    return event;
  }

  snapshot() {
    return {
      provider: this._provider || null,
      channel: this._channel || { name: 'twilio', ready: false },
      config: this.getConfig(),
      leads: this.listLeads(),
      log: this.log.slice(-200),
    };
  }

  setProvider(info) {
    this._provider = info; // { name, model }
  }

  setChannel(name, ready) {
    this._channel = { name, ready: !!ready };
  }
}

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : dflt;
}
function boolEnv(name, dflt) {
  const v = process.env[name];
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

export const store = new Store();
