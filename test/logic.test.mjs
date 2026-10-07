import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, hasVisibleProse, rebaseDraft, splitReasoning } from '../lib/logic.mjs';

test('only existing prose moves out of reasoning', () => {
    const reasoning = '梗概：两人见面。\n</thinking>下午四点，姜来走进教室。她看见了桌上的信。';
    const result = splitReasoning('', reasoning);
    assert.equal(result.body, '下午四点，姜来走进教室。她看见了桌上的信。');
    assert.ok(reasoning.includes(result.body));
    assert.equal(splitReasoning('', '梗概：两人见面。'), null);
    assert.equal(splitReasoning('', '下午四点，姜来走进教室。她看见了桌上的信，但文本里没有思考结束标签。'), null);
});

test('explicit body labels are accepted as boundaries without an API call', () => {
    const result = splitReasoning('', '梗概：两人见面。\n正文：下午四点，姜来走进教室。她看见了桌上的信。');
    assert.equal(result.body, '下午四点，姜来走进教室。她看见了桌上的信。');
    assert.equal(splitReasoning('', '梗概\n</thinking>她来了').body, '她来了');
});

test('embedded thinking can be moved without rewriting story', () => {
    const result = splitReasoning('<thinking>剧情梗概。</thinking>姜来走到了门口。', '旧思考');
    assert.equal(result.body, '姜来走到了门口。');
    assert.match(result.reasoning, /剧情梗概/);
});

test('fingerprint changes with either message field', () => {
    assert.notEqual(fingerprint('正文'), fingerprint('正文2'));
});

test('external body or reasoning changes rebase a preview onto current raw fields', () => {
    const first = { mes: '', extra: { reasoning: '</thinking>原始剧情已经开始。' } };
    const preview = rebaseDraft(null, 'chat:5:0', first);
    preview.body = '旧预览';
    preview.separated = true;
    assert.equal(rebaseDraft(preview, 'chat:5:0', first), preview);

    const changedBody = { mes: '插件修改后的正文。', extra: first.extra };
    const rebasedBody = rebaseDraft(preview, 'chat:5:0', changedBody);
    assert.equal(rebasedBody.body, changedBody.mes);
    assert.equal(rebasedBody.separated, false);

    const changedReasoning = { mes: changedBody.mes, extra: { reasoning: '插件修改后的思考。' } };
    const rebasedReasoning = rebaseDraft(rebasedBody, 'chat:5:0', changedReasoning);
    assert.equal(rebasedReasoning.reasoning, changedReasoning.extra.reasoning);
    assert.equal(rebasedReasoning.separated, false);
});

test('non-prose output is not a visible story', () => {
    assert.equal(hasVisibleProse('<update><json_patch>[]</json_patch></update><StatusPlaceHolderImpl/>'), false);
    assert.equal(hasVisibleProse('<details>英文剧情。</details>'), false);
    assert.equal(hasVisibleProse('<thinking>只有思考，没有正文。'), false);
    assert.equal(hasVisibleProse('她走进了教室。<update></update>'), true);
});
