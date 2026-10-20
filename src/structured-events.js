/** Keep OpenCode's explicit text/reasoning type. Do not infer it from language. */
export class StructuredEventFeed {
  constructor(sessionID, publish, fail) {
    this.sessionID = sessionID;
    this.publish = publish;
    this.fail = fail;
    this.assistants = new Set();
    this.parts = new Map();
  }
  accept(raw) {
    const event = raw?.payload ?? raw;
    const p = event?.properties ?? event?.data;
    if (!p) return;
    const sid = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID;
    if (sid !== this.sessionID) return;
    if (event.type === 'message.updated') {
      if (p.info?.role === 'assistant') this.assistants.add(p.info.id);
      return;
    }
    if (event.type === 'message.part.updated') {
      const part = p.part;
      if (part?.type === 'tool') {
        if (part.metadata?.providerExecuted || part.state?.metadata?.providerExecuted
          || (part.tool !== 'dsh_call' && part.state?.status === 'completed')) this.fail();
        return;
      }
      if (!['text', 'reasoning'].includes(part?.type) || !this.assistants.has(part.messageID)
        || typeof part.id !== 'string' || typeof part.text !== 'string') return;
      this.parts.set(part.id, { id: part.id, messageID: part.messageID, type: part.type, text: part.text });
      this.publish({ ...this.parts.get(part.id) });
    } else if (event.type === 'message.part.delta') {
      // Hold untyped deltas until the upstream typed snapshot, rather than
      // accidentally printing hidden reasoning in the answer area.
      const part = this.parts.get(p.partID);
      if (!part || part.messageID !== p.messageID || !this.assistants.has(p.messageID)
        || p.field !== 'text' || typeof p.delta !== 'string') return;
      part.text += p.delta;
      this.publish({ ...part });
    }
  }
}

/** DSH block indexes reset per step; delivered prefixes survive tool handoffs. */
export class StructuredBlocks {
  constructor(delivered) { this.delivered = delivered; this.blocks = new Map(); }
  get nextIndex() { return this.blocks.size; }
  *part(part) {
    if (!['text', 'reasoning'].includes(part.type) || typeof part.text !== 'string') return;
    const prior = this.delivered.get(part.id) ?? '';
    if (prior === part.text) return;
    let block = this.blocks.get(part.id);
    if (!block) {
      if (prior && !part.text.startsWith(prior)) return; // Do not replay earlier steps.
      block = { index: this.blocks.size, type: part.type, base: prior, text: '' };
      this.blocks.set(part.id, block);
      yield { type: 'block-start', index: block.index, blockType: block.type };
    }
    const current = part.text.startsWith(block.base) ? part.text.slice(block.base.length) : part.text;
    if (current.startsWith(block.text)) {
      const delta = current.slice(block.text.length);
      if (delta) yield { type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta',
        index: block.index, text: delta };
    }
    block.text = current;
    this.delivered.set(part.id, part.text);
  }
  *end() {
    for (const block of this.blocks.values()) yield { type: 'block-end', index: block.index,
      block: { type: block.type, text: block.text } };
  }
}
