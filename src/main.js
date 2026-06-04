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

const totalGroups = groupUrls.length;
let processedCount = 0;

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
/*  Diff mode — persist the set of post keys already returned per group */
/*  in the KV store. ID-based dedup is far more reliable than           */
/*  timestamps, which Facebook frequently does not expose in the feed.  */
/* ------------------------------------------------------------------ */

const KV_PREFIX = 'diff_seenKeys_';
const MAX_SEEN_KEYS = 5000; // bound the stored value size per group

async function getSeenKeys(groupSlug) {
    const store = await Actor.openKeyValueStore();
    const arr = await store.getValue(`${KV_PREFIX}${groupSlug}`);
    return Array.isArray(arr) ? arr : [];
}

async function saveSeenKeys(groupSlug, keys) {
    if (!keys?.length) return;
    const store = await Actor.openKeyValueStore();
    // Keep only the most recent keys to bound the stored value size.
    await store.setValue(`${KV_PREFIX}${groupSlug}`, keys.slice(-MAX_SEEN_KEYS));
    log.info(`Diff mode: saved ${Math.min(keys.length, MAX_SEEN_KEYS)} seen post key(s) for "${groupSlug}"`);
}

/* ------------------------------------------------------------------ */
/*  Per-group time budget                                               */
/*  Scale the request-handler timeout to the workload so big jobs       */
/*  (many posts + comments) are not killed mid-group — which would      */
/*  discard the entire group's data, since pushData runs only after     */
/*  scrapeGroup completes.                                              */
/* ------------------------------------------------------------------ */

function computeHandlerTimeoutSecs() {
    let secs = 120; // metadata + navigation overhead
    if (scrapePosts && maxPostsPerGroup > 0) {
        secs += maxPostsPerGroup * 6; // feed scrolling + extraction
        if (scrapeComments) secs += maxPostsPerGroup * 18; // per-post visit + comment paging
    }
    if (scrapeMembers && maxMembersPerGroup > 0) {
        secs += Math.ceil(maxMembersPerGroup / 10) * 4 + 60;
    }
    secs += (maxCheckpointRetries || 0) * 210; // room for checkpoint backoff (30+60+120s)
    return Math.min(Math.max(Math.round(secs), 300), 7200); // clamp 5 min .. 2 h
}

const handlerTimeoutSecs = computeHandlerTimeoutSecs();
log.info(`Per-group handler timeout budget: ${handlerTimeoutSecs}s`);

/* ------------------------------------------------------------------ */
/*  Crawler                                                             */
/* ------------------------------------------------------------------ */

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    headless,
    maxConcurrency: 1, // FB is strict — never run multiple sessions from same account
    // navigateWithRetry() already handles checkpoints with its own backoff/rotation,
    // so keep Crawlee's retries low to avoid re-scraping the whole group on every transient error.
    maxRequestRetries: 1,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: handlerTimeoutSecs,
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
        processedCount++;
        log.info(`Processing group ${processedCount}/${totalGroups}: ${url}`);
        await Actor.setStatusMessage(`Scraping ${processedCount}/${totalGroups}: ${url}`);

        const groupSlug = url.match(/\/groups\/([^/?#]+)/)?.[1];

        let result = null;
        let scrapeError = null;

        try {
            // Diff mode: load the set of post keys already returned in past runs.
            // Kept inside the try so a KV read failure becomes an error record
            // instead of throwing the whole request into Crawlee's retry loop.
            let seenKeys = [];
            if (diffMode && groupSlug) {
                seenKeys = await getSeenKeys(groupSlug);
                if (seenKeys.length) log.info(`Diff mode: ${seenKeys.length} post(s) already seen in previous runs`);
            }

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
                seenKeys,
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

            // Diff mode: persist the cumulative set of seen post keys for next run
            if (diffMode && groupSlug && result.seenKeysToSave) {
                await saveSeenKeys(groupSlug, result.seenKeysToSave);
            }

            log.info(`Done: ${url} — ${result.posts?.length || 0} posts, ${result.members?.length || 0} members`);
        } catch (e) {
            scrapeError = e;
            log.exception(e, `Failed to scrape ${url}`);
        }

        // Strip internal diff bookkeeping so it never lands in the dataset record.
        let outResult = result;
        if (outResult?.seenKeysToSave) {
            const { seenKeysToSave, ...rest } = outResult;
            outResult = rest;
        }

        const dataPayload = scrapeError
            ? { scrapedAt: new Date().toISOString(), groupUrl: url, error: scrapeError.message }
            : { scrapedAt: new Date().toISOString(), groupUrl: url, ...outResult };

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
            ...(diffMode && { newPostsCount: result?.posts?.length ?? 0 }),
            ...(minimaxApiKey && {
                flaggedPostsCount: result?.posts?.filter((p) => p.moderation?.flagged).length ?? 0,
            }),
            membersCount: result?.members?.length ?? 0,
            ...(scrapeError && { error: scrapeError.message }),
            scrapedAt: new Date().toISOString(),
        });
    },
    failedRequestHandler: async ({ request, error }) => {
        const { url } = request;
        log.error(`Request ${url} failed permanently: ${error.message}`);

        const groupSlug = url.match(/\/groups\/([^/?#]+)/)?.[1] || null;

        // Push an error record so the dataset has no silent gaps — consumers can
        // tell "group failed" apart from "group was never requested".
        await Actor.pushData({
            scrapedAt: new Date().toISOString(),
            groupUrl: url,
            groupSlug,
            error: `Permanently failed after retries: ${error.message}`,
        });

        const { actorRunId } = Actor.getEnv();
        await sendWebhook(webhookUrl, {
            event: 'group_scraped',
            actorRunId,
            groupUrl: url,
            groupSlug,
            status: 'error',
            postsCount: 0,
            membersCount: 0,
            error: error.message,
            scrapedAt: new Date().toISOString(),
        });
    },
});

// Normalize URLs — strip query params and ensure trailing slash
const requests = groupUrls.map((url) => ({
    url: url.split('?')[0].replace(/\/$/, '') + '/',
}));

await crawler.run(requests);

await Actor.setStatusMessage(`Finished — processed ${processedCount}/${totalGroups} group(s).`);

await Actor.exit();
