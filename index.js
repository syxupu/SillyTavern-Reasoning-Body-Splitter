import { eventSource, event_types, generateRaw, updateMessageBlock, saveChatConditional } from '/script.js';
import { getContext } from '/scripts/extensions.js';
import { hasVisibleProse, isPending, messageFingerprint, parseJsonAnswer, rebaseDraft, splitReasoning } from './lib/logic.mjs';

const KEY = 'reply_finalizer';
const EVENT = 'reply-finalizer:release';
let draft = null;
let busy = false;
let replayingSend = false;
let bridgeBusy = null;
let releasingConsumers = false;
let pendingGenerationResolve = null;
let generationPendingChat = null;

function context() { return getContext(); }
function idOf(ctx = context()) { return String(ctx?.chatId ?? ''); }
function target(ctx = context()) {
    const index = ctx?.chat?.length - 1;
    const message = ctx?.chat?.[index];
    if (!message || message.is_user || message.is_system) return null;
    return { ctx, index, message, chatId: idOf(ctx), swipeId: Number(message.swipe_id ?? 0) };
}
function keyOf(t) { return `${t.chatId}:${t.index}:${t.swipeId}`; }
function sameTarget(t, d = draft) {
    return !!d && target()?.message === t.message && keyOf(t) === d.key
        && messageFingerprint(t.message) === d.fingerprint && isPending(t.message);
}
function setMarker(t, marker) {
    t.message.extra ??= {};
    t.message.extra[KEY] = marker;
    const info = t.message.swipe_info?.[t.swipeId];
    if (info) { info.extra ??= {}; info.extra[KEY] = structuredClone(marker); }
}
function notify(message, level = 'info') {
    globalThis.toastr?.[level]?.(message, '回复定稿');
    setStatus(message);
}
function setStatus(message) {
    const status = document.querySelector('#reply-finalizer-status');
    if (status) { status.textContent = message; status.title = message; }
}
function lastPending() {
    const t = target();
    return t && isPending(t.message) ? t : null;
}
function needsRelease(t = target()) {
    return !!t && t.message.extra?.[KEY]?.status === 'committed'
        && t.message.extra[KEY].release !== 'complete';
}
async function markReleaseState(t, state) {
    if (keyOf(target()) !== keyOf(t)) return;
    setMarker(t, { ...t.message.extra[KEY], release: state });
    await save(t.ctx);
}

// Both LittleWhiteBox modules consult this synchronously. Their own listeners
// wait for the release event, so their load order does not affect the gate.
globalThis.ReplyFinalizerBridge = Object.freeze({
    isPending(chatId, messageId) {
        const ctx = context();
        if (idOf(ctx) !== String(chatId)) return false;
        if (isPending(ctx?.chat?.[messageId])) return true;
        // Streaming emits GENERATION_ENDED before MESSAGE_RECEIVED. Hold that
        // first event too, then persist the marker in MESSAGE_RECEIVED.
        return generationPendingChat === String(chatId) && messageId === ctx.chat?.length - 1 && !!ctx.chat?.[messageId] && !ctx.chat[messageId].is_user;
    },
    hasPendingThrough(chatId, messageId) {
        const ctx = context();
        return idOf(ctx) === String(chatId) && (ctx.chat?.slice(0, messageId + 1).some(isPending)
            || (generationPendingChat === String(chatId) && messageId >= ctx.chat?.length - 1));
    },
    get releasePromise() { return bridgeBusy; },
});

async function releaseConsumers(t) {
    bridgeBusy = (async () => {
        releasingConsumers = true;
        try {
            for (const phase of ['tasks', 'summary']) {
                const waits = [];
                globalThis.dispatchEvent(new CustomEvent(EVENT, {
                    detail: {
                        phase, chatId: t.chatId, messageId: t.index, swipeId: t.swipeId,
                        waitUntil(promise) { waits.push(Promise.resolve(promise)); },
                    },
                }));
                const results = await Promise.allSettled(waits);
                const failed = results.find(x => x.status === 'rejected');
                if (failed) {
                    const error = new Error(`${phase === 'summary' ? '小白盒总结' : '循环任务'}执行失败：${failed.reason?.message ?? failed.reason}`);
                    notify(error.message, 'warning');
                    if (phase === 'summary') throw error;
                }
            }
        } finally { releasingConsumers = false; }
    })();
    try { await bridgeBusy; } finally { bridgeBusy = null; }
}

async function ensureConsumersReleased() {
    if (bridgeBusy) {
        if (releasingConsumers) return true;
        try { await bridgeBusy; }
        catch (error) { notify(error.message || String(error), 'error'); return false; }
    }
    const t = target();
    if (!needsRelease(t)) {
        return true;
    }
    try {
        await releaseConsumers(t);
        await markReleaseState(t, 'complete');
        render();
        if (pendingGenerationResolve) { pendingGenerationResolve(); pendingGenerationResolve = null; }
        return true;
    } catch (error) {
        try { await markReleaseState(t, 'failed'); } catch (saveError) { console.error('[回复定稿] 保存总结失败状态时出错', saveError); }
        render();
        notify(error.message || String(error), 'error');
        return false;
    }
}

async function save(ctx) {
    if (typeof ctx?.saveChat === 'function') await ctx.saveChat();
    else await saveChatConditional();
}

async function markPending(messageId, type) {
    if (['quiet', 'impersonate', 'first_message'].includes(type)) return;
    const ctx = context();
    const t = target(ctx);
    if (!t || t.index !== messageId) return;
    generationPendingChat = null;
    if (type === 'swipe' && t.message.extra?.[KEY]?.status === 'committed') return;
    setMarker(t, {
        status: 'pending', swipeId: t.swipeId,
        fingerprint: messageFingerprint(t.message), createdAt: Date.now(),
    });
    draft = null;
    try { await save(ctx); }
    catch (error) { notify(`待定稿状态保存失败：${error.message || error}`, 'error'); }
    render();
}

function ensureDraft() {
    const t = lastPending();
    if (!t) throw new Error('当前最新回复没有待定稿版本');
    draft = rebaseDraft(draft, keyOf(t), t.message);
    return { t, draft };
}

function extractJson(raw) {
    try { return parseJsonAnswer(raw); }
    catch { throw new Error('模型没有返回有效 JSON，未改变回复'); }
}

async function callModel(system, payload) {
    const result = await generateRaw({
        systemPrompt: system,
        prompt: JSON.stringify(payload),
        responseLength: 4096,
        trimNames: false,
    });
    return extractJson(result);
}

async function separate({ silent = false } = {}) {
    const original = lastPending();
    if (!original) throw new Error('当前最新回复没有待定稿版本');
    const originalKey = keyOf(original);
    for (let attempt = 0; attempt < 3; attempt++) {
        const { t, draft: d } = ensureDraft();
        if (keyOf(t) !== originalKey) throw new Error('聊天或 swipe 已切换，分离已取消');
        if (d.separated) {
            if (!silent) notify('当前分离预览已是最新版本；检查后按 ✓ 定稿');
            return;
        }
        let separated = splitReasoning(d.body, d.reasoning);
        if (!separated && !d.body.trim() && d.reasoning.trim()) {
            const answer = await callModel(
                '从思考文本中寻找已经写成的连续剧情正文。只返回 JSON：{"startQuote":"正文开头连续原文至少20字","endQuote":"正文结尾连续原文至少20字"}。没有明确剧情则返回 {"startQuote":"","endQuote":""}。不得创作或改写。',
                { reasoning: d.reasoning },
            );
            const start = String(answer?.startQuote ?? '');
            const end = String(answer?.endQuote ?? '');
            const from = start.length >= 20 ? d.reasoning.indexOf(start) : -1;
            const to = end.length >= 20 ? d.reasoning.lastIndexOf(end) : -1;
            if (from >= 0 && to >= from && d.reasoning.indexOf(start, from + 1) < 0 && d.reasoning.indexOf(end) === to) {
                const extracted = d.reasoning.slice(from, to + end.length).trim();
                if (extracted.length >= 30 && /[。！？.!?]/.test(extracted)) {
                    separated = { body: extracted, reasoning: `${d.reasoning.slice(0, from)}${d.reasoning.slice(to + end.length)}`.trim(), mode: 'exact-quote' };
                }
            }
        }
        if (!sameTarget(t, d) || draft !== d) continue;
        if (!separated) throw new Error('没有找到可可靠搬移的连续剧情正文');
        d.body = separated.body;
        d.reasoning = separated.reasoning;
        d.separated = true;
        render();
        if (!silent) notify('已生成分离预览；检查后按 ✓ 定稿');
        return;
    }
    throw new Error('回复在分离期间持续变化，请稍后重试');
}

async function commit() {
    if (busy) return false;
    busy = true;
    let t, d;
    try {
        const original = lastPending();
        if (!original) throw new Error('当前最新回复没有待定稿版本');
        const originalKey = keyOf(original);
        const hadSeparation = draft?.key === originalKey && draft.separated;
        for (let attempt = 0; attempt < 3; attempt++) {
            ({ t, draft: d } = ensureDraft());
            if (keyOf(t) !== originalKey) throw new Error('聊天或 swipe 已切换，定稿已取消');
            if (hadSeparation && !d.separated && (!hasVisibleProse(d.body) || splitReasoning(d.body, d.reasoning))) {
                await separate({ silent: true });
            }
            ({ t, draft: d } = ensureDraft());
            if (keyOf(t) !== originalKey) throw new Error('聊天或 swipe 已切换，定稿已取消');
            if (sameTarget(t, d) && (!hadSeparation || d.separated || (hasVisibleProse(d.body) && !splitReasoning(d.body, d.reasoning)))) break;
            if (attempt === 2) throw new Error('回复在定稿期间持续变化，请稍后重试');
        }
        if (!hasVisibleProse(d.body)) throw new Error('正文仍为空；请先分离思考、重抽或手工补正文');
        const message = t.message;
        const before = structuredClone(message);
        try {
            message.mes = d.body;
            message.extra ??= {};
            message.extra.reasoning = d.reasoning;
            if (before.mes !== d.body) delete message.extra.display_text;
            if (String(before.extra?.reasoning ?? '') !== d.reasoning) delete message.extra.reasoning_signature;
            if (before.mes !== d.body || String(before.extra?.reasoning ?? '') !== d.reasoning) delete message.extra.token_count;
            if (Array.isArray(message.swipes) && message.swipe_id < message.swipes.length) message.swipes[message.swipe_id] = d.body;
            if (Array.isArray(message.swipe_info) && message.swipe_info[message.swipe_id]) {
                message.swipe_info[message.swipe_id].extra ??= {};
                message.swipe_info[message.swipe_id].extra.reasoning = d.reasoning;
                if (String(before.extra?.reasoning ?? '') !== d.reasoning) delete message.swipe_info[message.swipe_id].extra.reasoning_signature;
            }
            if (target()?.message !== message || keyOf(target()) !== d.key) throw new Error('聊天或 swipe 已切换，定稿已取消');
            setMarker(t, { status: 'committed', release: 'pending', swipeId: t.swipeId, fingerprint: messageFingerprint(message), committedAt: Date.now() });
            await save(t.ctx);
        } catch (error) {
            Object.keys(message).forEach(k => delete message[k]);
            Object.assign(message, before);
            throw error;
        }
        draft = null;
        updateMessageBlock(t.index, message);
        await eventSource.emit(event_types.MESSAGE_UPDATED, t.index);
        render();
        try { await releaseConsumers(t); await markReleaseState(t, 'complete'); }
        catch (error) {
            try { await markReleaseState(t, 'failed'); } catch (saveError) { console.error('[回复定稿] 保存总结失败状态时出错', saveError); }
            throw error;
        }
        if (pendingGenerationResolve) { pendingGenerationResolve(); pendingGenerationResolve = null; }
        notify('已定稿');
        return true;
    } catch (error) {
        notify(error.message || String(error), 'error');
        return false;
    } finally { busy = false; render(); }
}

async function cancelPendingForReplacement() {
    const t = lastPending();
    if (!t) return;
    setMarker(t, { status: 'cancelled', swipeId: t.swipeId });
    draft = null;
    await save(t.ctx);
    render();
}

async function beforeGeneration(type, _options, dryRun) {
    if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
    if (['regenerate', 'swipe'].includes(type)) { await cancelPendingForReplacement(); generationPendingChat = idOf(); return; }
    if (!await ensureConsumersReleased()) {
        await new Promise(resolve => { pendingGenerationResolve = resolve; });
    }
    const t = lastPending();
    if (!t) { generationPendingChat = idOf(); return; }
    if (!(await commit())) {
        await new Promise(resolve => { pendingGenerationResolve = resolve; });
    }
    generationPendingChat = idOf();
}

function interceptSend(event) {
    if (replayingSend) return;
    const isClick = event.type === 'click' && event.target?.closest?.('#send_but');
    const isEnter = event.type === 'keydown' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target?.closest?.('#send_textarea');
    if (!isClick && !isEnter) return;
    const t = lastPending();
    if (!t && !bridgeBusy && !needsRelease()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (busy) return;
    if (!t && bridgeBusy) { notify('正在等待循环任务或总结完成，请稍后发送', 'info'); return; }
    if (!t && needsRelease()) {
        const waitingGeneration = !!pendingGenerationResolve;
        (async () => { if (await ensureConsumersReleased() && !waitingGeneration) { replayingSend = true; try { document.querySelector('#send_but')?.click(); } finally { replayingSend = false; } } })().catch(error => notify(error.message || String(error), 'error'));
        return;
    }
    (async () => {
        const waitingGeneration = !!pendingGenerationResolve;
        if (t && !(await commit())) return;
        if (bridgeBusy) await bridgeBusy;
        if (waitingGeneration) return;
        replayingSend = true;
        try { document.querySelector('#send_but')?.click(); }
        finally { replayingSend = false; }
    })().catch(error => notify(error.message || String(error), 'error'));
}

function render() {
    const bar = document.querySelector('#reply-finalizer-bar');
    const preview = document.querySelector('#reply-finalizer-preview');
    if (!bar) return;
    const t = target();
    const pending = !!t && isPending(t.message);
    const incomplete = !pending && needsRelease(t);
    bar.hidden = false;
    bar.querySelectorAll('button').forEach(button => { button.disabled = !pending || busy; });
    if (incomplete) {
        setStatus(busy ? '正在等待循环任务和总结…' : '正文已定稿；总结尚未完成，下次发送时重试');
        if (preview) preview.hidden = true;
        return;
    }
    if (!pending) {
        setStatus(t ? '最新回复已定稿，等待下一条 AI 回复' : '等待 AI 回复');
        if (preview) preview.hidden = true;
        return;
    }
    const valid = draft && sameTarget(t);
    const hasPreview = valid && (draft.body !== t.message.mes || draft.reasoning !== String(t.message.extra?.reasoning ?? ''));
    setStatus(busy ? '处理中…' : (hasPreview ? '分离预览未写入聊天；按 ✓ 定稿' : '待定稿：可直接按 ✓'));
    if (!preview) return;
    preview.hidden = !hasPreview;
    if (!preview.hidden) {
        preview.querySelector('#reply-finalizer-body').value = draft.body;
    }
}

function mount() {
    const form = document.querySelector('#send_form');
    if (!form) return;
    let bar = document.querySelector('#reply-finalizer-bar');
    if (!bar) {
        bar = document.createElement('section');
        bar.id = 'reply-finalizer-bar';
        bar.innerHTML = `<div class="reply-finalizer-actions"><button type="button" class="qr--button" data-action="separate">分离思考</button><button type="button" class="qr--button" data-action="commit">✓</button><span id="reply-finalizer-status"></span></div>`;
        bar.addEventListener('click', async event => {
            const action = event.target?.closest?.('button')?.dataset.action;
            if (!action || busy) return;
            busy = true; render();
            try {
                if (action === 'separate') await separate();
                if (action === 'commit') { busy = false; await commit(); }
            } catch (error) { notify(error.message || String(error), 'error'); }
            finally { busy = false; render(); }
        });
    }
    let preview = document.querySelector('#reply-finalizer-preview');
    if (!preview) {
        preview = document.createElement('details');
        preview.id = 'reply-finalizer-preview';
        preview.hidden = true;
        preview.innerHTML = '<summary>查看分离预览</summary><textarea id="reply-finalizer-body" readonly></textarea>';
    }
    const quickReplyBar = form.querySelector('#qr--bar');
    const host = quickReplyBar?.querySelector(':scope > .qr--buttons') ?? quickReplyBar ?? form;
    let changed = false;
    if (bar.parentElement !== host) {
        if (host === form) form.prepend(bar);
        else host.append(bar);
        changed = true;
    }
    const previewAnchor = quickReplyBar ?? bar;
    if (preview.parentElement !== form || preview.previousElementSibling !== previewAnchor) {
        previewAnchor.after(preview);
        changed = true;
    }
    if (changed) render();
}

function mountWhenReady() {
    mount();
    const observer = new MutationObserver(records => {
        const changedComposer = records.some(record => {
            const element = record.target instanceof Element ? record.target : record.target.parentElement;
            if (element?.closest('#send_form')) return true;
            return [...record.addedNodes, ...record.removedNodes].some(node =>
                node instanceof Element && (node.matches('#send_form, #qr--bar') || node.querySelector('#send_form, #qr--bar')));
        });
        if (changedComposer) mount();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

eventSource.on(event_types.MESSAGE_RECEIVED, markPending);
// GENERATION_ENDED precedes MESSAGE_RECEIVED in streaming mode.
eventSource.on(event_types.GENERATION_STOPPED, () => {
    const heldChat = generationPendingChat;
    setTimeout(() => { if (generationPendingChat === heldChat) generationPendingChat = null; }, 5000);
});
eventSource.on(event_types.CHAT_CHANGED, () => { generationPendingChat = null; draft = null; mount(); render(); });
eventSource.on(event_types.MESSAGE_SWIPED, () => { draft = null; render(); });
eventSource.on(event_types.MESSAGE_DELETED, () => { draft = null; render(); });
eventSource.on(event_types.MESSAGE_EDITED, async messageId => {
    const t = lastPending();
    if (!t || t.index !== messageId) return;
    setMarker(t, { ...t.message.extra[KEY], fingerprint: messageFingerprint(t.message) });
    await save(t.ctx);
    render();
});
eventSource.on(event_types.MESSAGE_UPDATED, async messageId => {
    const t = lastPending();
    if (!t || t.index !== messageId) return;
    if (messageFingerprint(t.message) === t.message.extra[KEY].fingerprint) return;
    setMarker(t, { ...t.message.extra[KEY], fingerprint: messageFingerprint(t.message) });
    await save(t.ctx);
    render();
});
eventSource.makeFirst(event_types.GENERATION_STARTED, beforeGeneration);
document.addEventListener('click', interceptSend, true);
document.addEventListener('keydown', interceptSend, true);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountWhenReady, { once: true });
else mountWhenReady();
