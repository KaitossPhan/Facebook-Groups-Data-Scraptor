import { log } from 'apify';
import {
    extractMetadataFromAboutPage,
    extractPostsFromFeed,
    extractCommentsFromPost,
    extractMembersFromList,
} from './parser.js';

const sleep = (min, max) => {
    const ms = Math.floor(Math.random() * (max - min) + min);
    return new Promise((r) => setTimeout(r, ms));
};

async function autoScroll(page, { maxScrolls = 30, scrollDelay = [1500, 3000] } = {}) {
    let previousHeight = 0;
    let stableCount = 0;

    for (let i = 0; i < maxScrolls; i++) {
        const currentHeight = await page.evaluate(() => document.body.scrollHeight);

        if (currentHeight === previousHeight) {
            stableCount++;
            if (stableCount >= 3) {
                log.debug(`Scroll stopped — height stable for 3 iterations`);
                break;
            }
        } else {
            stableCount = 0;
        }
        previousHeight = currentHeight;

        await page.evaluate(() => {
            window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
        });

        await sleep(scrollDelay[0], scrollDelay[1]);
    }
}

function getGroupSlug(url) {
    const match = url.match(/\/groups\/([^/?#]+)/);
    return match ? match[1] : null;
}

async function detectBlockingPage(page) {
    const url = page.url();
    if (url.includes('/login') || url.includes('/checkpoint')) {
        return `Redirected to ${url} — session is invalid or account is checkpointed.`;
    }
    const title = (await page.title()).toLowerCase();
    if (title.includes('log in') || title.includes('login') || title.includes('blocked')) {
        return `Page title indicates block: "${title}"`;
    }
    return null;
}

/**
 * Navigate to a URL and retry if Facebook shows a checkpoint or login wall.
 * On each retry: calls opts.onCheckpoint() to rotate cookies, then waits with exponential backoff.
 */
async function navigateWithRetry(page, url, slug, opts) {
    const maxRetries = opts.maxCheckpointRetries ?? 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await sleep(2000, 4000);

        const block = await detectBlockingPage(page);
        if (!block) return;

        if (attempt >= maxRetries) {
            throw new Error(`[${slug}] Blocked after ${maxRetries + 1} attempt(s): ${block}`);
        }

        log.warning(`[${slug}] Checkpoint detected (attempt ${attempt + 1}/${maxRetries}): ${block}`);

        if (opts.onCheckpoint) {
            const newCookies = await opts.onCheckpoint(attempt + 1);
            if (newCookies) {
                await page.context().clearCookies();
                await page.context().addCookies(newCookies);
                log.info(`[${slug}] Rotated to next cookie set`);
            }
        }

        // Exponential backoff: 30s → 60s → 120s
        const backoffMs = Math.min(30_000 * 2 ** attempt, 120_000);
        log.info(`[${slug}] Waiting ${backoffMs / 1000}s before retry...`);
        await sleep(backoffMs, backoffMs + 10_000);
    }
}

/**
 * Main entry — orchestrates the scraping flow for a single group.
 */
export async function scrapeGroup(page, groupUrl, opts) {
    const slug = getGroupSlug(groupUrl);
    if (!slug) throw new Error(`Cannot parse group slug from URL: ${groupUrl}`);

    const result = {
        groupSlug: slug,
        metadata: null,
        posts: [],
        members: [],
    };

    // ---------- 1. METADATA ----------
    if (opts.scrapeMetadata) {
        log.info(`[${slug}] Fetching metadata...`);
        const aboutUrl = `https://www.facebook.com/groups/${slug}/about/`;
        await navigateWithRetry(page, aboutUrl, slug, opts);

        try {
            await page.waitForSelector('[role="main"]', { timeout: 15000 });
        } catch {
            log.warning(`[${slug}] Main content selector not found, continuing anyway`);
        }

        result.metadata = await extractMetadataFromAboutPage(page);
    }

    // ---------- 2. POSTS ----------
    if (opts.scrapePosts && opts.maxPostsPerGroup > 0) {
        log.info(`[${slug}] Fetching posts (target: ${opts.maxPostsPerGroup})...`);
        const feedUrl = `https://www.facebook.com/groups/${slug}/`;
        try {
            await navigateWithRetry(page, feedUrl, slug, opts);
        } catch (e) {
            log.warning(`[${slug}] Posts page blocked after all retries — returning metadata only. ${e.message}`);
            return result;
        }

        // Cap GraphQL array at 20× the post limit to avoid unbounded memory growth.
        const graphqlCap = opts.maxPostsPerGroup * 20;
        const graphqlPosts = [];

        const graphqlHandler = async (response) => {
            try {
                const url = response.url();
                if (!url.includes('/api/graphql/') || response.request().method() !== 'POST') return;
                if (graphqlPosts.length >= graphqlCap) return;
                const text = await response.text();
                text.split('\n').forEach((line) => {
                    if (!line.trim() || graphqlPosts.length >= graphqlCap) return;
                    try {
                        graphqlPosts.push(JSON.parse(line));
                    } catch { /* ignore non-JSON lines */ }
                });
            } catch { /* response may already be consumed */ }
        };

        page.on('response', graphqlHandler);

        const maxScrolls = Math.ceil(opts.maxPostsPerGroup / 3) + 5;
        await autoScroll(page, { maxScrolls });

        page.off('response', graphqlHandler);

        result.posts = await extractPostsFromFeed(page, graphqlPosts, opts.maxPostsPerGroup);
        log.info(`[${slug}] Collected ${result.posts.length} posts`);

        // ---------- 3. COMMENTS ----------
        if (opts.scrapeComments && result.posts.length > 0) {
            log.info(`[${slug}] Fetching comments for ${result.posts.length} posts...`);
            for (let i = 0; i < result.posts.length; i++) {
                const post = result.posts[i];
                if (!post.postUrl) continue;
                try {
                    post.comments = await extractCommentsFromPost(
                        page,
                        post.postUrl,
                        opts.maxCommentsPerPost,
                    );
                    log.debug(`  Post ${i + 1}/${result.posts.length}: ${post.comments.length} comments`);
                } catch (e) {
                    log.warning(`  Comment scrape failed for post ${i + 1}: ${e.message}`);
                    post.comments = [];
                }
                await sleep(2000, 5000);
            }
        }

        // ---------- DIFF MODE FILTER ----------
        if (opts.diffMode && opts.lastSeenAt) {
            const cutoff = new Date(opts.lastSeenAt).getTime();
            const before = result.posts.length;
            // Posts without timestamps are always included (conservative approach).
            result.posts = result.posts.filter((p) => {
                if (!p.timestamp) return true;
                return new Date(p.timestamp).getTime() > cutoff;
            });
            log.info(`[${slug}] Diff mode: ${result.posts.length}/${before} posts are new since ${opts.lastSeenAt}`);
            result.diffSince = opts.lastSeenAt;
        }
    }

    // ---------- 4. MEMBERS ----------
    if (opts.scrapeMembers && opts.maxMembersPerGroup > 0) {
        if (!opts.isLoggedIn) {
            log.warning(`[${slug}] Skipping members: requires login.`);
        } else {
            log.info(`[${slug}] Fetching members (target: ${opts.maxMembersPerGroup})...`);
            const membersUrl = `https://www.facebook.com/groups/${slug}/members/`;
            try {
                await navigateWithRetry(page, membersUrl, slug, opts);
            } catch (e) {
                log.warning(`[${slug}] Members page blocked after all retries — skipping. ${e.message}`);
                return result;
            }

            const maxScrolls = Math.ceil(opts.maxMembersPerGroup / 10) + 5;
            await autoScroll(page, { maxScrolls });
            result.members = await extractMembersFromList(page, opts.maxMembersPerGroup);
            log.info(`[${slug}] Collected ${result.members.length} members`);
        }
    }

    return result;
}
