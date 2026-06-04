import { log } from 'apify';

const SYSTEM_PROMPT = `You are a content moderation assistant for a Vietnamese gaming community (VNG Games).
Analyze the Facebook post text provided and determine if it violates content policies.
Respond ONLY with valid JSON — no markdown, no explanation outside the JSON:
{
  "flagged": <boolean>,
  "categories": [<one or more of: "spam","hate_speech","adult_content","violence","misinformation","other">],
  "confidence": <number 0.0–1.0>,
  "reason": "<brief explanation in Vietnamese or English>"
}
If the post is clean, return: {"flagged":false,"categories":[],"confidence":0.95,"reason":"No violation"}`;

/**
 * Parse the model's JSON reply, tolerating ```json fences or surrounding prose —
 * MiniMax (like most chat models) often wraps JSON in markdown despite instructions.
 */
function parseModelJson(content) {
    if (!content) return null;
    let s = String(content).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    try {
        return JSON.parse(s);
    } catch {
        const brace = s.match(/\{[\s\S]*\}/); // fall back to the first {...} block
        if (brace) {
            try { return JSON.parse(brace[0]); } catch { /* give up below */ }
        }
        return null;
    }
}

/**
 * Run MiniMax AI moderation on an array of posts.
 * Adds a `moderation` field to each post with flagged status and categories.
 * Non-blocking: failures are logged and the post is returned unchanged.
 *
 * @param {object[]} posts
 * @param {object}   config
 * @param {string}   config.apiKey       - MiniMax API key (Bearer token)
 * @param {string}   [config.model]      - MiniMax model ID (default: abab6.5s-chat)
 * @param {number}   [config.maxConcurrent] - Parallel requests (default: 3)
 */
export async function moderatePosts(posts, { apiKey, model = 'abab6.5s-chat', maxConcurrent = 3 } = {}) {
    if (!apiKey || !posts.length) return posts;

    const moderateOne = async (post) => {
        const text = post.text?.trim();
        if (!text || text.length < 10) return post;

        try {
            const res = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: text.slice(0, 2000) },
                    ],
                    temperature: 0.1,
                    max_tokens: 200,
                }),
                signal: AbortSignal.timeout(15_000),
            });

            if (!res.ok) {
                log.warning(`Moderation API HTTP ${res.status} for post ${post.postId || post.postUrl}`);
                return post;
            }

            const data = await res.json();
            const content = data.choices?.[0]?.message?.content;
            if (!content) return post;

            const modResult = parseModelJson(content);
            if (!modResult) {
                log.debug(`Moderation: unparseable response for post ${post.postId || '(no id)'}`);
                return post;
            }
            post.moderation = {
                flagged: Boolean(modResult.flagged),
                categories: Array.isArray(modResult.categories) ? modResult.categories : [],
                confidence: typeof modResult.confidence === 'number' ? modResult.confidence : null,
                reason: modResult.reason || null,
            };

            if (post.moderation.flagged) {
                log.warning(`Moderation flagged post ${post.postId || '(no id)'}: ${post.moderation.reason}`);
            }
        } catch (e) {
            log.debug(`Moderation skipped for post ${post.postId || '(no id)'}: ${e.message}`);
        }

        return post;
    };

    // Process in fixed-size batches to respect API rate limits
    for (let i = 0; i < posts.length; i += maxConcurrent) {
        await Promise.all(posts.slice(i, i + maxConcurrent).map(moderateOne));
    }

    return posts;
}
