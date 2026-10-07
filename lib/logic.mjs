export function fingerprint(text) {
    const value = String(text ?? '');
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${(hash >>> 0).toString(36)}`;
}

export function messageFingerprint(message) {
    return fingerprint(`${message?.mes ?? ''}\u0000${message?.extra?.reasoning ?? ''}`);
}

export function isPending(message) {
    return message?.extra?.reply_finalizer?.status === 'pending';
}

export function rebaseDraft(draft, key, message) {
    const hash = messageFingerprint(message);
    if (draft?.key === key && draft.fingerprint === hash) return draft;
    return {
        key, fingerprint: hash,
        body: String(message?.mes ?? ''),
        reasoning: String(message?.extra?.reasoning ?? ''),
        separated: false,
    };
}

export function hasVisibleProse(body) {
    const text = String(body ?? '')
        .replace(/<(update|UpdateVariable|thinking|think|analysis|details)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(thinking|think|analysis|details)\b[^>]*>[\s\S]*$/i, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\[[^\]]+\]/g, '')
        .trim();
    return /[\p{L}\p{N}]/u.test(text);
}

export function splitReasoning(body, reasoning) {
    const prose = String(body ?? '');
    const thought = String(reasoning ?? '');
    const embedded = prose.match(/^\s*<thinking>([\s\S]*?)<\/thinking>\s*([\s\S]*)$/i);
    if (embedded && embedded[2].trim()) {
        return { body: embedded[2].trim(), reasoning: [thought.trim(), embedded[1].trim()].filter(Boolean).join('\n\n'), mode: 'body-tag' };
    }
    if (prose.trim()) return null;
    const close = /<\/thinking>|<\/think>|<\/analysis>|(?:^|\n)\s*(?:正文|最终正文|正式正文|输出正文)\s*[:：]\s*/gi;
    let match, boundary = -1;
    while ((match = close.exec(thought)) !== null) boundary = match.index + match[0].length;
    if (boundary < 0) return null;
    const tail = thought.slice(boundary).trim();
    if (!tail) return null;
    return { body: tail, reasoning: thought.slice(0, boundary).trim(), mode: 'reasoning-tail' };
}
