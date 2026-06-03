import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { scrapeGroup } from './scraper.js';
import { moderatePosts } from './moderator.js';

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
    groupUrls = [],
    scrapeMetadata = true,
    scrapePosts = true,
    maxPostsPerGroup = 50,
    scrapeComments = false,
    maxCommentsPerPost = 20,
    scrapeMembers = false,
    maxMembersPerGroup = 100,
    fbCookies = null,
    fbCookiesList = [],
    proxyConfiguration: proxyInput,
    headless = true,
    webhookUrl = null,
    diffMode = false,
    maxCheckpointRetries = 3,
    minimaxApiKey = null,
    minimaxModel = 'abab6.5s-chat',
} = input;

if (!groupUrls.length) {
    throw new Error('No group URLs provided. Add at least one URL in `groupUrls`.');
}

/* ------------------------------------------------------------------ */
/*  Cookie pool                                                         */
/* ------------------------------------------------------------------ */

function normalizeCookies(cookies) {
    return cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.facebook.com',
        path: c.path || '/',
        expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? true,
        sameSite: c.sameSite === 'no_restriction' ? 'None'
            : c.sameSite === 'lax' ? 'Lax'
            : c.sameSite === 'strict' ? 'Strict' : 'Lax',
    }));
}

function parseCookieInput(raw) {
    if (!raw) return null;
    try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(arr)) throw new Error('must be an array');
        return normalizeCookies(arr);
    } catch (e) {
        log.warning(`Skipping invalid cookie set: ${e.message}`);
        return null;
    }
}

// Build pool from primary cookies + any extras in fbCookiesList
const cookiePool = [
    parseCookieInput(fbCookies),
    ...fbCookiesList.map(parseCookieInput),
].filter(Boolean);

if (cookiePool.length > 0) {
    log.info(`Cookie pool ready: ${cookiePool.length} set(s), ${cookiePool.reduce((s, c) => s + c.length, 0)} total cookies`);
} else {
    log.warning('No valid cookies provided — only public groups without login will work.');
}

// Mutable state used by preNavigationHooks and the onCheckpoint callback
const cookieState = { index: 0, cookies: cookiePool[0] || null };

/**
 * Called by scraper when a checkpoint is hit.
 * Rotates to the next cookie set and returns normalized cookies,
 * or null if there is only one set (no rotation possible).
 */
async function onCheckpoint(attemptNum) {
    if (cookiePool.length <= 1) return null;
    cookieState.index = (cookieState.index + 1) % cookiePool.length;
    cookieState.cookies = cookiePool[cookieState.index];
    log.info(`Cookie rotation: now using set ${cookieState.index + 1}/${cookiePool.length}`);
    return cookieState.cookies;
}

/* ------------------------------------------------------------------ */
/*  Webhook                                                             */
/* ------------------------------------------------------------------ */

async function sendWebhook(url, payload) {
    if (!url) return;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) log.warning(`Webhook returned HTTP ${res.status}`);
        else log.debug(`Webhook delivered to ${url}`);
    } catch (e) {
        log.warning(`Webhook failed (non-fatal): ${e.message}`);
    }
}

/* ------------------------------------------------------------------ */
/*  Diff mode — persist last-seen post timestamp per group in KV store  */
/* ------------------------------------------------------------------ */

const KV_PREFIX = 'diff_lastSeenAt_';

async function getDiffLastSeenAt(groupSlug) {
    const store = await Actor.openKeyValueStore();
    return await store.getValue(`${KV_PREFIX}${groupSlug}`);
}

async function saveDiffLastSeenAt(groupSlug, posts) {
    const times = posts
        .map((p) => p.timestamp)
        .filter(Boolean)
        .map((t) => new Date(t).getTime())
        .filter((t) => !isNaN(t));
    if (!times.length) return;
    const latest = new Date(Math.max(...times)).toISOString();
    const store = await Actor.openKeyValueStore();
    await store.setValue(`${KV_PREFIX}${groupSlug}`, latest);
    log.info(`Diff mode: saved lastSeenAt=${latest} for group "${groupSlug}"`);
}

/* ------------------------------------------------------------------ */
/*  Crawler                                                             */
/* ------------------------------------------------------------------ */

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    headless,
    maxConcurrency: 1, // FB is strict — never run multiple sessions from same account
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 600,
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['chrome'],
                operatingSystems: ['windows', 'macos'],
                devices: ['desktop'],
            },
        },
    },
    preNavigationHooks: [
        async ({ page }) => {
            if (cookieState.cookies) {
                try {
                    await page.context().addCookies(cookieState.cookies);
                } catch (e) {
                    log.warning(`Cookie injection failed: ${e.message}`);
                }
            }
            await page.setViewportSize({ width: 1366, height: 768 });
        },
    ],
    requestHandler: async ({ page, request }) => {
        const { url } = request;
        log.info(`Processing group: ${url}`);

        const groupSlug = url.match(/\/groups\/([^/?#]+)/)?.[1];

        // Diff mode: load last-seen timestamp before scraping
        let lastSeenAt = null;
        if (diffMode && groupSlug) {
            lastSeenAt = await getDiffLastSeenAt(groupSlug);
            if (lastSeenAt) log.info(`Diff mode: ignoring posts at or before ${lastSeenAt}`);
        }

        let result = null;
        let scrapeError = null;

        try {
            result = await scrapeGroup(page, url, {
                scrapeMetadata,
                scrapePosts,
                maxPostsPerGroup,
                scrapeComments,
                maxCommentsPerPost,
                scrapeMembers,
                maxMembersPerGroup,
                isLoggedIn: cookiePool.length > 0,
                maxCheckpointRetries,
                onCheckpoint,
                diffMode,
                lastSeenAt,
            });

            // AI moderation pipeline
            if (minimaxApiKey && result.posts?.length) {
                log.info(`Running AI moderation on ${result.posts.length} post(s)...`);
                result.posts = await moderatePosts(result.posts, {
                    apiKey: minimaxApiKey,
                    model: minimaxModel,
                });
                const flaggedCount = result.posts.filter((p) => p.moderation?.flagged).length;
                log.info(`Moderation complete: ${flaggedCount} post(s) flagged`);
            }

            // Diff mode: persist the latest timestamp for next run
            if (diffMode && result.posts?.length) {
                await saveDiffLastSeenAt(groupSlug, result.posts);
            }

            log.info(`Done: ${url} — ${result.posts?.length || 0} posts, ${result.members?.length || 0} members`);
        } catch (e) {
            scrapeError = e;
            log.exception(e, `Failed to scrape ${url}`);
        }

        const dataPayload = scrapeError
            ? { scrapedAt: new Date().toISOString(), groupUrl: url, error: scrapeError.message }
            : { scrapedAt: new Date().toISOString(), groupUrl: url, ...result };

        await Actor.pushData(dataPayload);

        // Webhook notification — fire & forget, never blocks the run
        const { actorRunId } = Actor.getEnv();
        await sendWebhook(webhookUrl, {
            event: 'group_scraped',
            actorRunId,
            groupUrl: url,
            groupSlug: result?.groupSlug || groupSlug,
            status: scrapeError ? 'error' : 'success',
            postsCount: result?.posts?.length ?? 0,
            ...(diffMode && { newPostsCount: result?.posts?.length ?? 0, diffSince: lastSeenAt }),
            ...(minimaxApiKey && {
                flaggedPostsCount: result?.posts?.filter((p) => p.moderation?.flagged).length ?? 0,
            }),
            membersCount: result?.members?.length ?? 0,
            ...(scrapeError && { error: scrapeError.message }),
            scrapedAt: new Date().toISOString(),
        });
    },
    failedRequestHandler: async ({ request, error }) => {
        log.error(`Request ${request.url} failed permanently: ${error.message}`);
    },
});

// Normalize URLs — strip query params and ensure trailing slash
const requests = groupUrls.map((url) => ({
    url: url.split('?')[0].replace(/\/$/, '') + '/',
}));

await crawler.run(requests);

await Actor.exit();
