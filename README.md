# Facebook Group Scraper (GS3)

Custom Apify Actor để scrape Facebook groups: metadata, posts, comments, members.
Build cho team GS3/VNG, data không qua bên thứ ba.

---

## 1. Cấu trúc project

```
facebook-group-scraper/
├── .actor/
│   ├── actor.json          # Apify Actor metadata
│   ├── input_schema.json   # UI form input trên Apify Console
│   └── Dockerfile          # Build environment
├── src/
│   ├── main.js             # Entry point — đọc input, khởi tạo crawler
│   ├── scraper.js          # Logic Playwright: scroll, click, navigate
│   └── parser.js           # Extract data từ DOM + GraphQL
├── package.json
└── README.md
```

---

## 2. Deploy lên Apify Console

### Cách A — qua Apify CLI (khuyên dùng)
```bash
npm install -g apify-cli
apify login          # paste API token từ https://console.apify.com/account/integrations
cd facebook-group-scraper
apify push           # build + deploy
```

### Cách B — qua Web Console
1. Vào https://console.apify.com → **Actors** → **Develop new** → **My Actors**
2. Click **Create new** → đặt tên (vd. `gs3-facebook-group-scraper`)
3. Trong tab **Source**, chọn **Multiple source files** → upload toàn bộ folder này
4. Click **Build** → đợi 3-5 phút

---

## 3. Chạy Actor

### Input mẫu (JSON)
```json
{
  "groupUrls": [
    "https://www.facebook.com/groups/vnggames-community/"
  ],
  "scrapeMetadata": true,
  "scrapePosts": true,
  "maxPostsPerGroup": 50,
  "scrapeComments": true,
  "maxCommentsPerPost": 20,
  "scrapeMembers": false,
  "fbCookies": "[...]",
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Cách export cookies từ browser
1. Login Facebook bằng **account burner** (KHÔNG dùng account chính)
2. Cài extension [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)
3. Vào facebook.com → click extension → **Export** → **Export as JSON**
4. Paste JSON đó vào field `fbCookies`

> ⚠️ Cookies có thời hạn (~30-90 ngày). Khi scraper bị redirect về `/login`, lấy cookies mới.

---

## 4. Output

Mỗi group được scrape → 1 record push vào Apify Dataset. Schema:

```json
{
  "scrapedAt": "2026-06-03T10:30:00.000Z",
  "groupUrl": "https://www.facebook.com/groups/example/",
  "groupSlug": "example",
  "metadata": {
    "name": "Group Name",
    "memberCount": 12345,
    "privacy": "public",
    "description": "...",
    "coverPhotoUrl": "https://scontent..."
  },
  "posts": [
    {
      "authorName": "Nguyen Van A",
      "authorProfileUrl": "https://...",
      "postUrl": "https://...",
      "postId": "1234567890",
      "text": "Post content...",
      "images": ["https://..."],
      "reactionCount": 42,
      "commentCount": 5,
      "timestamp": "2026-06-02T08:15:00.000Z",
      "comments": [
        { "authorName": "...", "text": "..." }
      ]
    }
  ],
  "members": [
    { "name": "...", "profileUrl": "...", "avatarUrl": "...", "role": "admin" }
  ]
}
```

---

## 5. Tích hợp với GS3 Internal Dashboard

Trên VPS, tạo một sync job pull data từ Apify Dataset về SQLite.

```javascript
// vps/jobs/sync-facebook-groups.js
import { ApifyClient } from 'apify-client';
import Database from 'better-sqlite3';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const db = new Database('./gs3.sqlite');

async function syncGroup(groupUrl) {
    // Trigger Actor run
    const run = await client.actor('your-username/gs3-facebook-group-scraper').call({
        groupUrls: [groupUrl],
        scrapePosts: true,
        maxPostsPerGroup: 100,
        fbCookies: process.env.FB_COOKIES,
    });

    // Pull dataset
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // Upsert vào SQLite
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO fb_groups
        (slug, name, member_count, privacy, scraped_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
        stmt.run(
            item.groupSlug,
            item.metadata?.name,
            item.metadata?.memberCount,
            item.metadata?.privacy,
            item.scrapedAt,
            JSON.stringify(item),
        );
    }
}

await syncGroup('https://www.facebook.com/groups/your-group/');
```

Đặt vào cron job hoặc trigger từ dashboard.

---

## 6. Chi phí ước tính

- **Compute**: ~$0.25 per CU. Một run scrape 1 group + 50 posts ≈ 0.05-0.1 CU = **$0.01-0.03/run**.
- **Residential proxy**: ~$8/GB. Một run dùng ~50-200 MB = **$0.4-1.6/run**.
- **Tổng**: scrape 10 group/ngày ≈ **$5-20/ngày** = **$150-600/tháng**.

> Để tiết kiệm: dùng `DATACENTER` proxy cho group public (rẻ hơn 10 lần), `RESIDENTIAL` chỉ cho private group.

---

## 7. Lưu ý quan trọng

1. **Selectors sẽ break**: Facebook đổi DOM ~1-2 tháng/lần. Khi scrape không ra data, check console log → update selectors trong `parser.js`.
2. **Account burner**: KHÔNG BAO GIỜ dùng cookie của account chính. Account burner = một số điện thoại riêng + email riêng + verify đầy đủ trước khi dùng.
3. **Rate limit**: Đừng chạy nhiều group song song với cùng 1 cookie. `maxConcurrency: 1` đã set sẵn.
4. **Pháp lý**: Scrape data member của group ngoài Facebook là vùng xám. Với group VNG mà bạn là admin, dùng **Facebook Graph API** chính thức (nhanh, hợp pháp, không bị block). Scraper này chỉ nên dùng cho:
   - Group bên ngoài để research thị trường
   - Backup data group VNG (vì API có thể không expose hết)
5. **GDPR/Nghị định 13/2023**: Data member là PII. Lưu trong SQLite phải có cơ chế xóa khi cần, encrypt at rest, log access.

---

## 8. Roadmap cải tiến

- [x] **Auto-retry khi gặp checkpoint** — `navigateWithRetry()` trong `scraper.js`: tự động retry với exponential backoff (30 s → 60 s → 120 s). Config qua input `maxCheckpointRetries` (default 3).
- [x] **Webhook trigger từ GS3 Dashboard** — sau mỗi group scrape (thành công hoặc lỗi), POST JSON đến `webhookUrl`. Payload gồm: `status`, `postsCount`, `flaggedPostsCount`, `error`, `actorRunId`, `scrapedAt`.
- [x] **Diff mode** — input `diffMode: true`. Lưu timestamp của post mới nhất vào Apify KV Store sau mỗi run. Run kế tiếp chỉ trả về post mới hơn thời điểm đó.
- [x] **Multi-cookie rotation** — input `fbCookiesList` (array JSON). Khi checkpoint xảy ra, `onCheckpoint()` callback tự động rotate sang cookie set kế tiếp trong pool. Hỗ trợ bất kỳ số lượng burner account.
- [x] **AI moderation pipeline** — input `minimaxApiKey` + `minimaxModel`. Module `src/moderator.js` gọi MiniMax ChatCompletion API theo batch (3 concurrent), gắn field `moderation: { flagged, categories, confidence, reason }` vào mỗi post. Non-blocking — lỗi API không làm crash run.

---

## 9. Bugs đã fix

| File | Dòng | Lỗi | Fix |
|------|------|-----|-----|
| `parser.js` | 89 | `article.closest('div[role="article"]')` luôn trả về chính article → nested articles không bao giờ bị skip | Đổi sang `article.parentElement?.closest(...)` |
| `scraper.js` | 125 | GraphQL response listener (`page.on('response', ...)`) không bao giờ bị remove → memory leak | Dùng named handler + `page.off('response', handler)` sau scroll |
| `scraper.js` | 130 | `graphqlPosts` array không giới hạn size → memory tăng không kiểm soát | Cap tại `maxPostsPerGroup × 20` |
