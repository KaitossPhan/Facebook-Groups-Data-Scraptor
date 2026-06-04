/**
 * Parser module.
 *
 * IMPORTANT: Facebook changes its DOM structure and GraphQL schema frequently.
 * Selectors in this file WILL break. When that happens, update the selectors
 * by inspecting the live page. We use multiple fallback strategies to make
 * this more resilient, but expect to maintain this file every 1-2 months.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/*  METADATA                                                                  */
/* -------------------------------------------------------------------------- */

export async function extractMetadataFromAboutPage(page) {
    // Evaluate inside the page — pull whatever we can find
    return await page.evaluate(() => {
        const meta = {};

        // Group name — usually in <h1>
        meta.name = document.querySelector('h1')?.textContent?.trim() || null;

        // Description, member count, privacy — look in the "About" section
        // FB uses generic divs, so we search by text content
        const allText = document.body.innerText;

        // Member count: "12.3K members" / "1,234 members" / "5 members"
        const memberMatch = allText.match(/([\d.,KMkm]+)\s*member/i);
        if (memberMatch) {
            const raw = memberMatch[1].toLowerCase().replace(/,/g, '');
            let count = parseFloat(raw);
            if (raw.includes('k')) count *= 1000;
            if (raw.includes('m')) count *= 1000000;
            meta.memberCount = Math.round(count);
            meta.memberCountRaw = memberMatch[0];
        }

        // Privacy
        if (/public group/i.test(allText)) meta.privacy = 'public';
        else if (/private group/i.test(allText)) meta.privacy = 'private';
        else meta.privacy = 'unknown';

        // Visibility (visible / hidden) — only relevant for private groups
        if (/visible.*anyone can find/i.test(allText)) meta.visibility = 'visible';
        else if (/hidden.*only members/i.test(allText)) meta.visibility = 'hidden';

        // Description — usually the longest block of text in the "About this group" section
        const aboutHeader = Array.from(document.querySelectorAll('h2, h3, span'))
            .find((el) => /about this group/i.test(el.textContent || ''));
        if (aboutHeader) {
            const container = aboutHeader.closest('div[role="article"]')
                || aboutHeader.parentElement?.parentElement;
            if (container) {
                meta.description = container.innerText
                    .replace(/about this group/i, '')
                    .trim()
                    .slice(0, 2000);
            }
        }

        // Cover photo — first img inside the cover area
        const coverImg = document.querySelector('[role="main"] img[src*="scontent"]');
        if (coverImg) meta.coverPhotoUrl = coverImg.src;

        // Page URL (canonical)
        meta.canonicalUrl = document.querySelector('link[rel="canonical"]')?.href || null;

        return meta;
    });
}

/* -------------------------------------------------------------------------- */
/*  POSTS                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Walk a parsed GraphQL response and record post timestamps into `map`
 * (numericPostId -> ISO creation time, or null when only the id is known).
 * Called per streamed line while scrolling, so we never retain full response objects.
 */
export function collectPostMeta(obj, map) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.__typename === 'Story' || obj.creation_time || obj.post_id) {
        const id = obj.post_id || obj.id;
        if (id != null) {
            const key = String(id);
            const time = obj.creation_time
                ? new Date(obj.creation_time * 1000).toISOString()
                : null;
            // A real timestamp always wins; a bare id only fills an empty slot.
            if (time || !map.has(key)) map.set(key, time);
        }
    }
    if (Array.isArray(obj)) {
        for (const v of obj) collectPostMeta(v, map);
    } else {
        for (const v of Object.values(obj)) collectPostMeta(v, map);
    }
}

/**
 * Combine DOM-extracted posts with GraphQL-intercepted timestamps.
 * DOM gives us layout / what's currently visible; `postMeta` (a Map of
 * numericPostId -> ISO creation time) supplies reliable timestamps.
 */
export async function extractPostsFromFeed(page, postMeta, maxPosts) {
    // 1. Pull posts from DOM (simpler, always works for the basics)
    const domPosts = await page.evaluate(() => {
        const posts = [];
        // FB uses role="article" for posts in the feed
        const articles = document.querySelectorAll('div[role="article"]');

        articles.forEach((article) => {
            try {
                // Skip nested articles (e.g. shared posts inside posts).
                // parentElement.closest() avoids matching the article against itself.
                if (article.parentElement?.closest('div[role="article"]')) return;

                const post = {};

                // Author — first link to /user/... or /profile.php inside the article
                const authorLink = article.querySelector('a[href*="/user/"], a[href*="/profile.php"], h3 a, h4 a');
                if (authorLink) {
                    post.authorName = authorLink.textContent?.trim() || null;
                    post.authorProfileUrl = authorLink.href || null;
                }

                // Permalink — link to post itself
                const permalink = article.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[aria-label*="hour"], a[aria-label*="minute"], a[aria-label*="day"]');
                if (permalink) post.postUrl = permalink.href;

                // Text content
                const textBlock = article.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
                if (textBlock) {
                    post.text = textBlock.innerText.trim();
                } else {
                    // Fallback: largest text block in the article that isn't the author name
                    const allDivs = Array.from(article.querySelectorAll('div'));
                    const longest = allDivs
                        .map((d) => d.innerText)
                        .filter((t) => t && t.length > 30)
                        .sort((a, b) => b.length - a.length)[0];
                    if (longest) post.text = longest.slice(0, 5000);
                }

                // Images
                const images = Array.from(article.querySelectorAll('img[src*="scontent"]'))
                    .map((img) => img.src)
                    .filter((src) => !src.includes('/emoji.php/') && !src.includes('safe_image'));
                if (images.length) post.images = [...new Set(images)].slice(0, 20);

                // Engagement counts (approximate, from aria-labels)
                const reactionsEl = article.querySelector('[aria-label*="reaction"], [aria-label*="Like:"]');
                if (reactionsEl) {
                    const m = reactionsEl.getAttribute('aria-label')?.match(/[\d,]+/);
                    if (m) post.reactionCount = parseInt(m[0].replace(/,/g, ''), 10);
                }
                const commentsEl = article.querySelector('[aria-label*="comment"]');
                if (commentsEl) {
                    const m = commentsEl.getAttribute('aria-label')?.match(/[\d,]+/);
                    if (m) post.commentCount = parseInt(m[0].replace(/,/g, ''), 10);
                }

                // Timestamp tooltip — hover-revealed, often unreliable without hovering
                const timeEl = article.querySelector('a[role="link"] abbr, a[aria-label*=":"][aria-label*="20"]');
                if (timeEl) {
                    post.timestampLabel = timeEl.getAttribute('aria-label') || timeEl.title || null;
                }

                // Only push if we got something meaningful
                if (post.text || post.postUrl || post.images) {
                    posts.push(post);
                }
            } catch { /* one bad post shouldn't kill the whole feed */ }
        });

        return posts;
    });

    // 2. Enrich with GraphQL data.
    // Pull the numeric post id out of each permalink and attach it (always — diff-mode
    // dedup relies on a stable key) plus the timestamp when GraphQL provided one.
    domPosts.forEach((post) => {
        if (!post.postUrl) return;
        const m = post.postUrl.match(/\/posts\/(\d+)|\/permalink\/(\d+)|multi_permalinks=(\d+)|story_fbid=(\d+)/);
        const postId = m?.[1] || m?.[2] || m?.[3] || m?.[4];
        if (postId) {
            post.postId = postId;
            if (postMeta && postMeta.has(postId)) post.timestamp = postMeta.get(postId);
        }
    });

    // Dedupe. Prefer a stable key (URL / id); only fall back to author+text when there
    // IS text, so two different posts sharing an opening line aren't merged into one.
    const dedup = [];
    const seen = new Set();
    for (const post of domPosts) {
        const key = post.postUrl
            || post.postId
            || (post.text ? `${post.authorName || ''}::${post.text.slice(0, 200)}` : null);
        if (!key) {
            // No stable key (e.g. image-only post) — include rather than drop.
            dedup.push(post);
        } else if (!seen.has(key)) {
            seen.add(key);
            dedup.push(post);
        }
        if (dedup.length >= maxPosts) break;
    }

    return dedup;
}

/* -------------------------------------------------------------------------- */
/*  COMMENTS                                                                  */
/* -------------------------------------------------------------------------- */

export async function extractCommentsFromPost(page, postUrl, maxComments) {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
    await sleep(2500);

    // Click "View more comments" repeatedly until we have enough or no more button
    let clicks = 0;
    const maxClicks = Math.ceil(maxComments / 10) + 2;
    while (clicks < maxClicks) {
        const moreBtn = await page.$('div[role="button"]:has-text("more comment"), div[role="button"]:has-text("View more")');
        if (!moreBtn) break;
        try {
            await moreBtn.click();
            await sleep(1500);
            clicks++;
        } catch {
            break;
        }
    }

    return await page.evaluate((max) => {
        const comments = [];
        // Comment containers usually have role="article" within the comments section
        const commentEls = document.querySelectorAll('div[aria-label*="omment"] div[role="article"]');

        commentEls.forEach((el) => {
            if (comments.length >= max) return;
            const c = {};
            const authorLink = el.querySelector('a[href*="/user/"], a[href*="/profile.php"]');
            if (authorLink) {
                c.authorName = authorLink.textContent?.trim();
                c.authorUrl = authorLink.href;
            }
            // Comment text — usually in a div without children, longest text
            const textEls = Array.from(el.querySelectorAll('div'))
                .map((d) => ({ el: d, text: d.innerText }))
                .filter((x) => x.text && x.text.length > 0 && x.el.children.length <= 2);
            if (textEls.length) {
                c.text = textEls.sort((a, b) => b.text.length - a.text.length)[0].text.slice(0, 2000);
            }
            if (c.text || c.authorName) comments.push(c);
        });

        return comments;
    }, maxComments);
}

/* -------------------------------------------------------------------------- */
/*  MEMBERS                                                                   */
/* -------------------------------------------------------------------------- */

export async function extractMembersFromList(page, maxMembers) {
    return await page.evaluate((max) => {
        const members = [];
        const seen = new Set();

        // Each member row is typically a link to a profile inside role="main"
        const profileLinks = document.querySelectorAll(
            '[role="main"] a[href*="/user/"], [role="main"] a[href*="/profile.php"]'
        );

        profileLinks.forEach((link) => {
            if (members.length >= max) return;
            const href = link.href.split('?')[0];
            if (seen.has(href)) return;
            seen.add(href);

            // Filter out non-member links (group admins might link to their own profiles in rules, etc.)
            const name = link.textContent?.trim();
            if (!name || name.length < 2 || name.length > 100) return;

            const member = { name, profileUrl: href };

            // Try to get profile picture from sibling image
            const row = link.closest('div[role="listitem"]') || link.closest('li') || link.parentElement;
            const img = row?.querySelector('img[src*="scontent"]');
            if (img) member.avatarUrl = img.src;

            // Role badge (admin / moderator) — usually next to name
            const rowText = row?.innerText || '';
            if (/admin/i.test(rowText)) member.role = 'admin';
            else if (/moderator/i.test(rowText)) member.role = 'moderator';

            members.push(member);
        });

        return members;
    }, maxMembers);
}
