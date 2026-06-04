# PROJECT CONTEXT — Facebook Group Scraper (GS3)

> Tài liệu context đầy đủ để bất kỳ AI nào hiểu rõ project mà không cần truy cập source code.
> Tự sinh bằng cách reverse-engineer codebase. KHÔNG chứa secret/credential, KHÔNG dump full source.

---

## 1. 📌 META INFO

- **Project name:** `facebook-group-scraper` (title: "Facebook Group Scraper (GS3)")
- **Version:** `0.1.0` (package.json) — Actor version `0.1` trên Apify
- **Scan date:** 2026-06-04
- **Scanned by:** Claude AI on VPS
- **Total files scanned:** 10 file tracked (4 source JS + 5 config/schema + 1 README)
- **Total lines of code (estimate):** ~853 dòng source JS (`src/`) + ~450 dòng config/README ≈ **~1.300 dòng** tổng
- **Primary language:** JavaScript (Node.js ≥18, **ESM** — `"type": "module"`)
- **Project size:** ~48 KB (source `src/` + `.actor/`, không tính `node_modules`)
- **Loại project:** **Apify Actor** (web scraper chạy headless Chromium qua Crawlee/Playwright) — KHÔNG phải web app / REST API server.

---

## 2. 🎯 PROJECT SUMMARY

- **One-liner:** Apify Actor scrape dữ liệu công khai từ các Facebook group (metadata, posts, comments, members).
- **Purpose:** Công cụ nội bộ cho team **GS3 / VNG** để thu thập dữ liệu Facebook group phục vụ research thị trường và backup data group của VNG. Chạy trên nền tảng Apify (cloud), xuất dữ liệu ra Apify Dataset rồi đồng bộ về dashboard nội bộ (SQLite). Có tích hợp tùy chọn kiểm duyệt nội dung bằng AI (MiniMax) và thông báo qua webhook.
- **Target users:** Kỹ sư/analyst nội bộ GS3-VNG (không phải sản phẩm public). Cần tài khoản Apify + cookie Facebook (burner account).
- **Key features:**
  - Scrape **metadata** group: tên, mô tả, số thành viên, privacy, ảnh bìa.
  - Scrape **posts** trong feed (kết hợp DOM + chặn GraphQL response để lấy timestamp).
  - Scrape **comments** dưới mỗi post (tùy chọn).
  - Scrape **members** (chỉ khi tài khoản đã login và là thành viên group).
  - **Multi-cookie rotation** — xoay nhiều bộ cookie burner khi gặp checkpoint.
  - **Auto-retry checkpoint** với exponential backoff (30s → 60s → 120s).
  - **Diff mode** — chỉ trả về post mới (ID-based dedup, lưu state trong KV Store).
  - **AI moderation** — gắn cờ vi phạm chính sách qua MiniMax ChatCompletion API (tùy chọn).
  - **Webhook** — POST thông báo sau mỗi group (thành công hoặc lỗi).
  - **Anti-bot**: fingerprint giả lập, viewport cố định, `maxConcurrency: 1`, residential proxy.
- **Current status:** Development / internal (version 0.1.x). Đã deploy build thành công lên Apify Console.

---

## 3. 🛠️ TECH STACK

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Platform | Apify Actor | actorSpecification 1 | Chạy & quản lý job trên cloud Apify |
| Runtime | Node.js (ESM) | ≥18 (image dùng 20) | JS runtime |
| Crawler framework | Crawlee `PlaywrightCrawler` | ^3.11.5 | Quản lý request queue, retry, browser pool, proxy |
| Browser automation | Playwright (Chromium) | `*` (theo base image) | Điều khiển headless Chrome |
| SDK | apify | ^3.2.6 | Actor lifecycle, Dataset, Key-Value Store, proxy, log |
| Container | Docker (apify base image) | `apify/actor-node-playwright-chrome:20` | Build environment (Chrome cài sẵn) |
| Storage (output) | Apify Dataset | — | 1 record / group |
| Storage (state) | Apify Key-Value Store | — | Lưu seen-keys cho diff mode |
| AI (optional) | MiniMax ChatCompletion API | model `abab6.5s-chat` | Content moderation |
| Proxy | Apify Proxy (RESIDENTIAL mặc định) | — | Tránh block IP từ Facebook |

> **Không dùng:** database server, REST API framework, frontend, ORM. Đây là batch scraper, không có UI/endpoint.

---

## 4. 📁 FOLDER STRUCTURE

```
Facebook-Groups-Data-Scraptor/
├── .actor/                      # Cấu hình Apify Actor
│   ├── actor.json               # Metadata Actor (name, version, input/dataset schema ref)
│   ├── input_schema.json        # Định nghĩa form input trên Apify Console (17 field)
│   ├── dataset_schema.json      # Output schema + table view cho Console
│   └── Dockerfile               # Build image (base: actor-node-playwright-chrome:20)
├── src/                         # Toàn bộ logic
│   ├── main.js                  # Entry point — input, crawler, cookie pool, webhook, diff KV, moderation orchestration
│   ├── scraper.js               # Flow scrape 1 group: navigate+retry, autoScroll, GraphQL intercept, diff filter
│   ├── parser.js                # Trích xuất data từ DOM + GraphQL (metadata/posts/comments/members)
│   └── moderator.js             # Gọi MiniMax AI moderation theo batch
├── package.json                 # Deps + scripts (ESM)
├── README.md                    # Tài liệu tiếng Việt (deploy, run, cost, legal, roadmap)
└── PROJECT_CONTEXT.md           # (file này)
```

- **Không có** `node_modules/`, `dist/`, `build/` trong repo. **Không có** `.gitignore` (xem section 12).
- Cấu trúc **phẳng theo trách nhiệm** (layer-based trong 1 thư mục `src/`), không chia feature-folder.

---

## 5. 🗄️ DATABASE SCHEMA

> ⚠️ Project **KHÔNG dùng database truyền thống** (không Postgres/MySQL/Mongo, không ORM). Lưu trữ dựa hoàn toàn vào **storage của Apify**: Dataset (output) + Key-Value Store (state). Dưới đây là "schema" tương đương.

### Apify Dataset — 1 record / group (output chính)
| Field | Type | Note |
|---|---|---|
| `scrapedAt` | ISO string | Thời điểm scrape |
| `groupUrl` | string | URL group đã chuẩn hoá |
| `groupSlug` | string | Phần định danh sau `/groups/` |
| `metadata` | object\|null | name, description, memberCount, privacy, visibility, coverPhotoUrl, canonicalUrl |
| `posts` | object[] | Danh sách post (xem dưới) |
| `members` | object[] | name, profileUrl, avatarUrl, role |
| `error` | string (optional) | Chỉ có khi group lỗi/bị block |

**Sub-object `posts[]`:**
| Field | Type | Note |
|---|---|---|
| `authorName` / `authorProfileUrl` | string | Tác giả |
| `postUrl` / `postId` | string | Permalink + numeric id (id dùng cho diff dedup) |
| `text` | string | Nội dung (cắt tối đa ~5000 ký tự) |
| `images` | string[] | Tối đa 20 ảnh `scontent` |
| `reactionCount` / `commentCount` | number | Ước lượng từ aria-label |
| `timestamp` | ISO string\|null | Best-effort từ GraphQL |
| `comments` | object[] | (nếu bật `scrapeComments`) authorName, authorUrl, text |
| `moderation` | object | (nếu bật MiniMax) flagged, categories, confidence, reason |

### Apify Key-Value Store — state cho diff mode
| Key | Value | Mục đích |
|---|---|---|
| `diff_seenKeys_<groupSlug>` | string[] (tối đa 5000) | Tập postId/postUrl đã trả về ở các run trước, để chỉ xuất post mới |

---

## 6. 🔌 API REFERENCE

> ⚠️ Project **KHÔNG có HTTP/REST endpoint**. "Interface" của Actor gồm: **Input** (khi start run), **Output** (Dataset record ở section 5), và **Webhook out** (gọi ra ngoài). Dưới đây là hợp đồng I/O.

### Input fields (`.actor/input_schema.json`)
| Field | Type | Required | Default | Mô tả |
|---|---|---|---|---|
| `groupUrls` | array | **Yes** | — | Danh sách URL group cần scrape |
| `scrapeMetadata` | boolean | No | `true` | Lấy metadata group |
| `scrapePosts` | boolean | No | `true` | Lấy posts |
| `maxPostsPerGroup` | integer | No | `50` | 0–1000 (0 = unlimited) |
| `scrapeComments` | boolean | No | `false` | Lấy comment mỗi post (chậm) |
| `maxCommentsPerPost` | integer | No | `20` | 0–500 |
| `scrapeMembers` | boolean | No | `false` | Lấy member list (cần login + là thành viên) |
| `maxMembersPerGroup` | integer | No | `100` | 0–5000 |
| `fbCookies` | string (secret, textarea) | No | — | JSON array cookie export từ Cookie-Editor |
| `fbCookiesList` | array (stringList) | No | — | Các bộ cookie phụ để rotation |
| `proxyConfiguration` | object (proxy) | No | RESIDENTIAL | Cấu hình Apify Proxy |
| `headless` | boolean | No | `true` | Tắt để xem browser khi dev local |
| `webhookUrl` | string | No | — | URL nhận thông báo sau mỗi group |
| `diffMode` | boolean | No | `false` | Chỉ trả post mới (ID-based) |
| `maxCheckpointRetries` | integer | No | `3` | 0–10 lần retry khi gặp checkpoint |
| `minimaxApiKey` | string (secret) | No | — | Bật AI moderation nếu có |
| `minimaxModel` | string | No | `abab6.5s-chat` | Model MiniMax dùng cho moderation |

### Input mẫu (quan trọng nhất)
```json
{
  "groupUrls": ["https://www.facebook.com/groups/example/"],
  "scrapeMetadata": true,
  "scrapePosts": true,
  "maxPostsPerGroup": 30,
  "fbCookies": "[ ...JSON cookie array... ]",
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

### Webhook OUT payload (POST → `webhookUrl`)
```json
{
  "event": "group_scraped",
  "actorRunId": "string",
  "groupUrl": "https://...",
  "groupSlug": "example",
  "status": "success | error",
  "postsCount": 30,
  "newPostsCount": 12,          // chỉ khi diffMode
  "flaggedPostsCount": 2,       // chỉ khi bật MiniMax
  "membersCount": 0,
  "error": "string",            // chỉ khi status=error
  "scrapedAt": "ISO string"
}
```

---

## 7. 🧩 KEY MODULES & FILES

### `src/main.js`
- **Purpose:** Entry point của Actor — đọc input, dựng crawler, điều phối toàn bộ pipeline.
- **Trách nhiệm chính:** `Actor.init/exit`, parse + normalize cookie pool, `onCheckpoint()` (rotation), `sendWebhook()`, diff KV helpers (`getSeenKeys`/`saveSeenKeys`), `computeHandlerTimeoutSecs()` (timeout động), cấu hình `PlaywrightCrawler` (proxy, fingerprint, preNavigationHooks inject cookie), `requestHandler` + `failedRequestHandler`, gọi `Actor.pushData` + `Actor.setStatusMessage`.
- **Used by:** Là entry (`npm start`).
- **Dependencies:** `apify`, `crawlee`, `./scraper.js`, `./moderator.js`.

### `src/scraper.js`
- **Purpose:** Điều phối flow scrape cho **1 group**.
- **Exports:** `scrapeGroup(page, groupUrl, opts)`.
- **Nội bộ:** `sleep()`, `autoScroll()`, `getGroupSlug()`, `detectBlockingPage()`, `navigateWithRetry()` (retry + backoff + cookie rotation), chặn GraphQL response để gom timestamp (`collectPostMeta` vào Map), **diff filter ID-based chạy trước comments**.
- **Used by:** `main.js`.
- **Dependencies:** `apify` (log), `./parser.js`.

### `src/parser.js`
- **Purpose:** Trích xuất dữ liệu thô từ DOM + GraphQL (chạy `page.evaluate`).
- **Exports:** `extractMetadataFromAboutPage()`, `extractPostsFromFeed()`, `extractCommentsFromPost()`, `extractMembersFromList()`, `collectPostMeta()`.
- **Used by:** `scraper.js`.
- **Dependencies:** không có (thuần DOM/JS). ⚠️ Header file ghi rõ: **selector sẽ break ~1-2 tháng/lần** khi FB đổi DOM.

### `src/moderator.js`
- **Purpose:** Kiểm duyệt nội dung post bằng MiniMax AI.
- **Exports:** `moderatePosts(posts, { apiKey, model, maxConcurrent })`.
- **Nội bộ:** `parseModelJson()` (strip markdown code-fence + fallback trích `{...}`), batch 3 request đồng thời, non-blocking (lỗi API không crash run).
- **Used by:** `main.js` (chỉ khi có `minimaxApiKey`).
- **Dependencies:** `apify` (log), global `fetch`.

---

## 8. 🔄 DATA FLOW

### Flow 1: Vòng đời 1 run
```
[Apify run start] input JSON
   ↓ Actor.init() + Actor.getInput()
[main.js] build cookiePool, proxyConfig, handlerTimeout động
   ↓ crawler.run(requests)   (requests = groupUrls đã chuẩn hoá)
[PlaywrightCrawler] maxConcurrency=1, maxRequestRetries=1
   ↓ mỗi URL → requestHandler
[scrapeGroup()] (xem Flow 2)
   ↓ (optional) moderatePosts()
   ↓ Actor.pushData(record)  +  sendWebhook()
[Actor.setStatusMessage("Finished")] → Actor.exit()
```

### Flow 2: Scrape 1 group (`scrapeGroup`)
```
[metadata] /groups/<slug>/about/  → navigateWithRetry → extractMetadataFromAboutPage
   ↓
[posts] /groups/<slug>/  → page.on('response') chặn GraphQL → collectPostMeta(Map)
   ↓ autoScroll(maxScrolls)
   ↓ extractPostsFromFeed(page, postMeta) → gắn postId + timestamp, dedupe
   ↓
[diff filter]  (nếu diffMode) lọc post đã thấy bằng seenKeys → set seenKeysToSave
   ↓
[comments]  (nếu scrapeComments) goto từng postUrl → extractCommentsFromPost
   ↓
[members]   (nếu scrapeMembers & isLoggedIn) /members/ → autoScroll → extractMembersFromList
   ↓ return { groupSlug, metadata, posts, members }
```

### Flow 3: Checkpoint retry + cookie rotation
```
navigateWithRetry(page, url)
   ↓ page.goto → detectBlockingPage()  (check /login, /checkpoint, title)
   ├─ không block → return
   └─ block & còn retry:
        onCheckpoint() → xoay sang cookie set kế tiếp (clearCookies + addCookies)
        backoff 30s → 60s → 120s (sleep) → thử lại
   ↓ hết retry → throw → group đó push record {error}
```

### Flow 4: AI moderation (optional)
```
moderatePosts(posts) → chia batch 3 → mỗi post:
   POST api.minimax.chat/v1/text/chatcompletion_v2 (timeout 15s)
   → parseModelJson(content) → gắn post.moderation { flagged, categories, confidence, reason }
   (lỗi/parse fail → bỏ qua post đó, không crash)
```

### Flow 5: Diff mode (ID-based)
```
run N:   getSeenKeys(slug) → Set cũ
         scrape → lọc post có key ∉ Set  → trả post mới
         saveSeenKeys(slug, Set cũ ∪ key mọi post run này)  (cap 5000)
run N+1: chỉ thấy post chưa từng xuất hiện
```

---

## 9. ⚙️ CONFIG & ENVIRONMENT VARIABLES

> Project **không có file `.env` / `.env.example`**. Cấu hình runtime đến qua **Apify input** (section 6), không qua biến môi trường tự định nghĩa.

### Biến môi trường liên quan (do Apify/base image cấp)
| Variable | Type | Required | Mục đích |
|---|---|---|---|
| `APIFY_TOKEN` | string | (khi dùng client/CLI bên ngoài) | Xác thực với Apify API (dùng ở snippet sync trong README) |
| Biến `APIFY_*` của runtime | — | Auto | Apify tự set khi chạy trên platform (run id, dataset id, proxy...) |
| `PLAYWRIGHT_*` (trong base image) | — | Auto | Đường dẫn/skip-download browser (do image quản lý) |

- **Secret trong input:** `fbCookies`, `minimaxApiKey` được đánh dấu `isSecret: true` trong input schema.
- ⚠️ KHÔNG có credential nào hard-code trong source.

---

## 10. 📦 KEY DEPENDENCIES

### Production (`dependencies`)
- `apify` (^3.2.6) — Apify SDK: Actor lifecycle, Dataset, Key-Value Store, proxy, logging.
- `crawlee` (^3.11.5) — `PlaywrightCrawler`: request queue, retry, browser pool, fingerprint.
- `playwright` (`*`) — Chromium automation. **Cố ý để `*`** để dùng đúng browser đã bundle trong base image (xem comment trong Dockerfile).

### Dev
- Không có dev dependency. Script `test` chỉ là stub (`echo "No tests yet"`).

> Tổng cộng chỉ 3 production dependency trực tiếp — codebase gọn, ít bề mặt phụ thuộc.

---

## 11. 🎨 CODE CONVENTIONS & PATTERNS

- **Module system:** ESM (`import/export`, `"type": "module"`).
- **Naming:** `camelCase` cho biến/hàm; file name flat theo vai trò (`main.js`, `scraper.js`, `parser.js`, `moderator.js`).
- **Folder pattern:** layer-based gọn trong 1 thư mục `src/` (không feature-folder).
- **Error handling:** try/catch bao quanh mỗi group; lỗi 1 group → push record `{error}`, không làm hỏng run. Webhook & moderation là **non-blocking** (lỗi chỉ log).
- **Async:** dùng `async/await`, `Promise.all` theo batch (moderation), `AbortSignal.timeout()` cho fetch.
- **Logging:** dùng `log` của apify (`log.info/warning/error/debug/exception`), không dùng `console`.
- **Validation:** dựa vào Apify input schema (không Joi/Zod). Cookie parse có guard riêng (`parseCookieInput`).
- **Anti-bot pattern:** fingerprint generator, viewport cố định 1366×768, `--disable-blink-features=AutomationControlled`, `maxConcurrency: 1`, backoff + cookie rotation.
- **Resilience pattern:** GraphQL intercept incremental vào `Map` (tránh giữ object lớn); timeout handler động theo workload; diff ID-based thay vì timestamp.
- **Comment style:** song ngữ — chú thích kỹ thuật bằng tiếng Anh, README + một số ghi chú bằng tiếng Việt. Không dùng JSDoc đầy đủ (chỉ vài block doc-comment).
- **Linter/Formatter:** **không** có cấu hình ESLint/Prettier trong repo.
- **Testing:** **chưa có** test (script `test` là stub).

---

## 12. 🐛 KNOWN ISSUES, TODO, TECH DEBT

> Quét code **không thấy** marker `TODO/FIXME/HACK/XXX/BUG` literal nào. Dưới đây là tech debt quan sát được + ghi chú từ README/header.

- **Selector dễ vỡ:** `parser.js` header cảnh báo FB đổi DOM ~1-2 tháng/lần → selector posts/comments/members sẽ break, cần bảo trì định kỳ.
- **Timestamp post là best-effort:** việc match `postId` từ URL với GraphQL không phải lúc nào cũng có → `timestamp` có thể `null`. (Đã giảm rủi ro cho diff mode bằng dedup theo ID thay vì timestamp.)
- **Chưa có test tự động:** không có unit/integration test; `npm test` chỉ echo.
- **Không có `.gitignore`:** rủi ro lỡ commit `node_modules/` hoặc file nhạy cảm → **nên thêm `.gitignore`** (ít nhất `node_modules`, `storage/`, `.env`).
- **Không có `package-lock.json`:** cố ý (đi cùng `playwright: "*"`); đánh đổi tính reproducible — muốn chắc chắn thì pin tag base image `:20-<pwVersion>`.
- **Proxy mặc định RESIDENTIAL:** tốn chi phí cho group public (README gợi ý DATACENTER cho public) — là quyết định per-run, chưa tối ưu mặc định.
- **Mid-group resilience:** nếu Actor bị migrate giữa lúc scrape, group đang chạy bị scrape lại từ đầu (Crawlee giữ request queue, nhưng tiến độ trong group không persist).
- **Pháp lý/PII (README §7):** scrape member là vùng xám; data member là PII → cần cơ chế xóa/encrypt khi lưu về dashboard (Nghị định 13/2023, GDPR).

---

## 13. 🚀 HOW TO RUN

### Prerequisites
- Tài khoản **Apify** (chạy cloud) — khuyên dùng.
- (Local) Node.js ≥18 + `apify-cli`.
- Cookie Facebook export từ **burner account** (cho group private / giảm block).
- (Optional) MiniMax API key nếu bật moderation.

### Deploy lên Apify
```bash
npm install -g apify-cli
apify login            # paste API token
apify push             # build + deploy
```
Hoặc qua Web Console: Actors → Develop new → upload folder → Build.

### Chạy (trên Apify Console)
1. Mở Actor → **Source → Input** (hoặc **Runs → Start new run**) — đây mới là form nhập input (tab *Information → Input* chỉ là tài liệu read-only).
2. Điền input (tối thiểu `groupUrls`; thêm `fbCookies` nếu cần login).
3. ⚠️ Set **Memory ≥ 2048 MB** (khuyên 4096) vì Playwright + Chrome.
4. Bấm **Start**.

### Chạy local (dev)
```bash
npm install
apify run            # hoặc: node src/main.js  (cần input qua apify storage)
```

### Scripts available
| Script | Mô tả |
|---|---|
| `npm start` | `node src/main.js` — chạy Actor |
| `npm test` | Stub (chưa có test) |

### Output
- Mỗi group → 1 record trong **Apify Dataset** (xem section 5).
- (Optional) đồng bộ Dataset về SQLite bằng `apify-client` (snippet trong README §5).

---

## 14. 💬 AI ONBOARDING TEMPLATE

Copy prompt dưới đây vào AI khác (ChatGPT/Gemini/Claude), kèm toàn bộ file này:

```
Tôi đang làm việc với project sau. Đây là context document đầy đủ về project.
Hãy đọc kỹ và sẵn sàng giúp tôi với các câu hỏi/tasks tiếp theo.

═══ START PROJECT CONTEXT ═══
[Paste toàn bộ nội dung PROJECT_CONTEXT.md vào đây]
═══ END PROJECT CONTEXT ═══

Sau khi đọc xong, hãy:
1. Tóm tắt ngắn project trong 3-5 câu để xác nhận bạn đã hiểu
2. Liệt kê các giả định bạn sẽ dùng khi trả lời
3. Đợi câu hỏi/task tiếp theo của tôi

Nguyên tắc: Chỉ dựa vào thông tin trong context document này. KHÔNG bịa
thông tin không có trong document. Nếu thiếu thông tin, hãy nói rõ
"cần thêm thông tin về X" thay vì đoán. Lưu ý: đây là Apify Actor (scraper),
KHÔNG có REST API / database truyền thống — lưu trữ qua Apify Dataset + KV Store.
```

---

## 15. 📜 FULL SOURCE DUMP

> Toàn bộ source code (verbatim, bản hiện tại). Đủ để AI tái dựng/hiểu 100% hành vi.
> ⚠️ KHÔNG có credential thật trong code; `fbCookies`/`minimaxApiKey` đến từ input lúc chạy.

### `src/main.js`
```javascript
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
```

### `src/scraper.js`
```javascript
import { log } from 'apify';
import {
    extractMetadataFromAboutPage,
    extractPostsFromFeed,
    extractCommentsFromPost,
    extractMembersFromList,
    collectPostMeta,
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

        // Extract post timestamps from GraphQL responses incrementally into a small
        // Map (postId -> ISO creation time). We parse each streamed line, pull just the
        // id + time, and discard the rest — instead of buffering thousands of full
        // (and often huge) FB response objects in memory.
        const tsCap = opts.maxPostsPerGroup * 10;
        const postMeta = new Map();

        const graphqlHandler = async (response) => {
            try {
                const url = response.url();
                if (!url.includes('/api/graphql/') || response.request().method() !== 'POST') return;
                if (postMeta.size >= tsCap) return;
                const text = await response.text();
                for (const line of text.split('\n')) {
                    if (!line.trim() || postMeta.size >= tsCap) continue;
                    try {
                        collectPostMeta(JSON.parse(line), postMeta);
                    } catch { /* ignore non-JSON lines */ }
                }
            } catch { /* response may already be consumed */ }
        };

        page.on('response', graphqlHandler);

        const maxScrolls = Math.ceil(opts.maxPostsPerGroup / 3) + 5;
        await autoScroll(page, { maxScrolls });

        page.off('response', graphqlHandler);

        result.posts = await extractPostsFromFeed(page, postMeta, opts.maxPostsPerGroup);
        log.info(`[${slug}] Collected ${result.posts.length} posts`);

        // ---------- DIFF MODE FILTER ----------
        // Runs before comments so we never spend time fetching comments for posts
        // that were already returned in a previous run.
        if (opts.diffMode) {
            const keyOf = (p) => p.postId || p.postUrl || null;
            const seen = new Set(opts.seenKeys || []);
            const before = result.posts.length;

            // New = posts whose key wasn't seen before. Keyless posts are always kept.
            const newPosts = result.posts.filter((p) => {
                const k = keyOf(p);
                return !(k && seen.has(k));
            });

            // Cumulative seen set = previously seen + every keyed post observed this run.
            const allKeys = new Set(opts.seenKeys || []);
            for (const p of result.posts) {
                const k = keyOf(p);
                if (k) allKeys.add(k);
            }

            log.info(`[${slug}] Diff mode: ${newPosts.length}/${before} posts are new (seen set: ${allKeys.size})`);
            result.posts = newPosts;
            result.seenKeysToSave = [...allKeys];
        }

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
```

### `src/parser.js`
```javascript
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
```

### `src/moderator.js`
> ⚠️ Block này dùng fence **4 dấu backtick** vì code có chứa chuỗi ` ``` ` (triple-backtick) trong regex.

````javascript
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
````

### `package.json`
```json
{
    "name": "facebook-group-scraper",
    "version": "0.1.0",
    "type": "module",
    "description": "Scrape Facebook groups: metadata, posts, comments, members. Built for GS3/VNG internal use.",
    "engines": { "node": ">=18" },
    "scripts": {
        "start": "node src/main.js",
        "test": "echo \"No tests yet\" && exit 0"
    },
    "dependencies": {
        "apify": "^3.2.6",
        "crawlee": "^3.11.5",
        "playwright": "*"
    },
    "author": "GS3 / Kiệt",
    "license": "UNLICENSED"
}
```

### `.actor/actor.json`
```json
{
    "actorSpecification": 1,
    "name": "facebook-group-scraper",
    "title": "Facebook Group Scraper (GS3)",
    "description": "Scrape metadata, posts, comments, and members from Facebook groups.",
    "version": "0.1",
    "buildTag": "latest",
    "meta": { "templateId": "playwright-javascript" },
    "input": "./input_schema.json",
    "dockerfile": "./Dockerfile",
    "storages": { "dataset": "./dataset_schema.json" }
}
```

### `.actor/Dockerfile`
```dockerfile
# Apify's official Node + Playwright image (Chrome pre-installed)
FROM apify/actor-node-playwright-chrome:20

# Copy package files first (better layer caching)
COPY --chown=myuser package*.json ./

# Install production deps.
# NOTE: package.json pins "playwright": "*" on purpose. The base image ships a
# Chromium build matched to a specific Playwright version; "*" lets npm keep that
# pre-installed version instead of pulling a newer one whose browser isn't present
# (which would crash at launch). Do NOT switch this to `npm ci` — that would
# reinstall the locked Playwright version and re-introduce the browser mismatch.
# For fully reproducible builds, pin the base image tag instead (e.g. :20-<pwVersion>).
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed packages:" \
    && npm list --omit=dev --all || true

# Copy the rest of the source
COPY --chown=myuser . ./

# Default command
CMD ./start_xvfb_and_run_cmd.sh && npm start --silent
```

> `.actor/input_schema.json` (17 field) và `.actor/dataset_schema.json` (table view) đã mô tả đầy đủ ở Section 6 và Section 5 — không lặp lại JSON ở đây để giữ file gọn.

---

## 16. 🔍 DETAILED CODE WALKTHROUGH (cách hoạt động chi tiết)

### A. `main.js` — entry point & orchestration

1. **Init & input** (`Actor.init` → `Actor.getInput`): nạp toàn bộ config từ Apify input, destructure với default. Nếu `groupUrls` rỗng → throw ngay (fail fast).
2. **Cookie pool:**
   - `normalizeCookies()` chuyển định dạng cookie export (Cookie-Editor: `expirationDate`, `sameSite: "no_restriction"`...) sang định dạng Playwright (`expires`, `sameSite: "None"/"Lax"/"Strict"`). Mặc định `domain=.facebook.com`, `secure=true`.
   - `parseCookieInput()` parse 1 chuỗi JSON → array cookie đã normalize; lỗi thì log warning + trả `null` (không crash).
   - `cookiePool` = `[fbCookies, ...fbCookiesList]` đã parse, lọc bỏ `null`. Có ≥1 bộ thì login được; không có thì chỉ scrape được group public.
   - `cookieState` = state mutable `{ index, cookies }` — bộ cookie đang dùng. Dùng chung bởi `preNavigationHooks` (inject) và `onCheckpoint` (rotation).
3. **`onCheckpoint(attemptNum)`**: khi bị checkpoint, xoay sang bộ cookie kế tiếp (`index = (index+1) % len`) và trả về cookie mới; nếu chỉ có 1 bộ → trả `null` (không xoay được).
4. **`sendWebhook(url, payload)`**: POST JSON, timeout 10s qua `AbortSignal.timeout`. Lỗi/HTTP non-2xx chỉ log — **không bao giờ làm hỏng run** (fire-and-forget).
5. **Diff KV helpers**: `getSeenKeys(slug)` đọc array key đã thấy từ KV (`diff_seenKeys_<slug>`), `saveSeenKeys` ghi lại (cắt còn `MAX_SEEN_KEYS=5000` phần tử cuối để giới hạn dung lượng).
6. **`computeHandlerTimeoutSecs()`**: tính timeout động cho mỗi group = 120s nền + `maxPostsPerGroup×6` (scroll/extract) + (`×18` nữa nếu có comment) + members + `maxCheckpointRetries×210` (chừa chỗ cho backoff). Clamp 300s–7200s. → tránh bị Apify kill giữa group (vì `pushData` chỉ chạy sau khi scrape xong cả group).
7. **Crawler config:**
   - `maxConcurrency: 1` — tuyệt đối không chạy song song cùng 1 account (FB block ngay).
   - `maxRequestRetries: 1` — vì `navigateWithRetry` đã tự retry checkpoint, không để Crawlee retry chồng làm re-scrape cả group nhiều lần.
   - `requestHandlerTimeoutSecs` = timeout động ở trên; `navigationTimeoutSecs: 90`.
   - `launchOptions.args` — tắt cờ automation để giảm bị phát hiện bot.
   - `browserPoolOptions.useFingerprints` — sinh fingerprint Chrome/Windows/macOS desktop ngẫu nhiên.
   - `preNavigationHooks` — trước MỖI điều hướng: inject `cookieState.cookies` + set viewport 1366×768.
8. **`requestHandler` (xử lý 1 group):**
   - Tăng `processedCount`, set status message (hiện progress trên Console).
   - Trong `try`: (a) nếu diffMode → `getSeenKeys`; (b) gọi `scrapeGroup(...)`; (c) nếu có `minimaxApiKey` → `moderatePosts`; (d) nếu diffMode → `saveSeenKeys(result.seenKeysToSave)`.
   - `catch` → lưu `scrapeError` (không throw tiếp).
   - **Strip** `seenKeysToSave` ra khỏi `result` trước khi push (không để lọt vào dataset record).
   - `Actor.pushData(dataPayload)` — record thành công (`...outResult`) hoặc record lỗi (`{error}`).
   - `sendWebhook(...)` — payload gồm status/counts (xem Section 6). Các field conditional dùng spread `...(cond && {...})`.
9. **`failedRequestHandler`**: khi 1 group fail hết retry của Crawlee → vẫn `pushData({error})` + `sendWebhook(status:error)` → dataset không bị "lỗ hổng thầm lặng".
10. **Chuẩn hoá URL**: cắt query (`split('?')[0]`), bỏ `/` cuối rồi thêm lại → đảm bảo URL group nhất quán có trailing slash.
11. **`crawler.run(requests)` → `setStatusMessage("Finished")` → `Actor.exit()`**.

### B. `scraper.js` — flow scrape 1 group

- **`sleep(min,max)`**: delay ngẫu nhiên (giả lập người dùng).
- **`autoScroll(page, {maxScrolls})`**: cuộn xuống ~80% viewport mỗi lần; theo dõi `document.body.scrollHeight`. Nếu chiều cao **không đổi 3 lần liên tiếp** → coi như hết nội dung, dừng sớm. Tối đa `maxScrolls` lần.
- **`detectBlockingPage(page)`**: nhận diện bị chặn — URL chứa `/login` hoặc `/checkpoint`, hoặc `<title>` chứa "log in"/"blocked". Trả lý do (string) hoặc `null` nếu OK.
- **`navigateWithRetry(page, url, slug, opts)`**: vòng lặp tối đa `maxCheckpointRetries+1` lần: `goto` → sleep → `detectBlockingPage`. Nếu OK → return. Nếu bị chặn và còn lượt: gọi `onCheckpoint` (xoay cookie → `clearCookies` + `addCookies`), rồi backoff lũy thừa `min(30s×2^attempt, 120s)` + jitter 0–10s. Hết lượt → throw.
- **`scrapeGroup(page, groupUrl, opts)` — 4 phase tuần tự:**
  1. **METADATA**: vào `/about/`, đợi `[role="main"]` (15s, bỏ qua nếu không thấy), gọi `extractMetadataFromAboutPage`.
  2. **POSTS**: vào feed `/`. **Đăng ký `page.on('response')`** để bắt response GraphQL (`/api/graphql/`, method POST). Mỗi response: tách theo dòng, `JSON.parse` từng dòng, gọi `collectPostMeta` để gom `postId→timestamp` vào `Map` (cap `maxPostsPerGroup×10` để chặn phình RAM). `autoScroll` (`ceil(maxPosts/3)+5` lần). **Gỡ listener** (`page.off`). Gọi `extractPostsFromFeed(page, postMeta, maxPosts)`.
  3. **DIFF FILTER** (chạy **trước** comments): nếu `diffMode`, key = `postId||postUrl`; `newPosts` = post có key chưa thấy trong `seenKeys`; `allKeys` = `seenKeys ∪ key của mọi post run này` → lưu vào `result.seenKeysToSave`. Gán `result.posts = newPosts`. (→ không tốn thời gian fetch comment cho post cũ.)
  4. **COMMENTS** (nếu bật): với mỗi post có `postUrl`, gọi `extractCommentsFromPost`, sleep 2–5s giữa các post. Lỗi 1 post → `comments=[]`, không dừng.
  5. **MEMBERS** (nếu bật & `isLoggedIn`): vào `/members/`, `autoScroll` (`ceil(maxMembers/10)+5`), `extractMembersFromList`. Nếu chưa login → bỏ qua + warning.
  - Nếu feed/members bị chặn hết retry → trả `result` với phần đã có (graceful degradation), không throw.

### C. `parser.js` — trích xuất DOM + GraphQL (chạy trong `page.evaluate`, môi trường browser)

- **`extractMetadataFromAboutPage`**: lấy `name` từ `<h1>`; quét `document.body.innerText` bằng regex: member count (hỗ trợ `12.3K`/`1,234` → nhân 1000/1e6), privacy (public/private/unknown), visibility (visible/hidden). Description = block text trong section "About this group" (cắt 2000 ký tự). Cover photo = ảnh `scontent` đầu trong `[role=main]`. `canonicalUrl` từ `<link rel=canonical>`.
- **`collectPostMeta(obj, map)`**: đệ quy toàn bộ object GraphQL; node là post khi có `__typename==='Story'` hoặc `creation_time` hoặc `post_id`. Lấy `id = post_id||id`, `time = creation_time×1000 → ISO`. Quy tắc ghi Map: **timestamp thật luôn ghi đè; id trơn (null time) chỉ điền nếu chưa có** → tránh ghi đè time tốt bằng null.
- **`extractPostsFromFeed(page, postMeta, maxPosts)`**:
  - *Phần 1 (DOM)*: duyệt `div[role="article"]`, **bỏ qua article lồng nhau** (shared post) bằng `parentElement?.closest('div[role=article]')`. Mỗi post lấy: author (link `/user/`,`/profile.php`,`h3 a`,`h4 a`), permalink, text (`data-ad-preview="message"`; fallback = div có text dài nhất >30 ký tự, cắt 5000), images (`scontent`, loại emoji/safe_image, unique, ≤20), reaction/comment count (parse số từ aria-label), `timestampLabel` (best-effort). Chỉ push nếu có text/url/images.
  - *Phần 2 (merge GraphQL)*: regex lấy `postId` từ permalink (`/posts/`,`/permalink/`,`multi_permalinks=`,`story_fbid=`). **Luôn gán `post.postId`** (cần cho diff dedup), gán `timestamp` nếu `postMeta` có id đó.
  - *Dedup*: key ưu tiên `postUrl → postId → author::text(200)`. Post không có key (vd chỉ ảnh) vẫn được giữ (không drop). Cắt khi đủ `maxPosts`.
- **`extractCommentsFromPost(page, postUrl, maxComments)`**: `goto` post, click "View more comments" tối đa `ceil(maxComments/10)+2` lần. Sau đó duyệt `div[aria-label*="omment"] div[role="article"]`: author + text (div có ≤2 con, text dài nhất, cắt 2000).
- **`extractMembersFromList(page, maxMembers)`**: duyệt link profile trong `[role=main]`, dedup theo href (bỏ query). Lọc name 2–100 ký tự. Lấy avatar (`scontent` trong row), role badge (admin/moderator từ text của row).

### D. `moderator.js` — AI moderation (optional)

- **`SYSTEM_PROMPT`**: bắt model trả JSON `{flagged, categories[], confidence, reason}` cho cộng đồng game VNG.
- **`parseModelJson(content)`**: strip markdown code-fence (dạng json) nếu có; thử `JSON.parse`; fallback trích block `{...}` đầu tiên. Trả `null` nếu vẫn fail (→ post không gắn moderation, không crash).
- **`moderatePosts(posts, {apiKey, model, maxConcurrent=3})`**: bỏ qua nếu không có apiKey hoặc post < 10 ký tự. Mỗi post: POST `api.minimax.chat/v1/text/chatcompletion_v2` (Bearer, temp 0.1, max_tokens 200, timeout 15s). Parse → gắn `post.moderation`. **Chạy theo batch 3 request đồng thời** (`Promise.all` từng slice) để tôn trọng rate limit. Mọi lỗi đều non-blocking (chỉ log debug).

### E. Quyết định thiết kế quan trọng (gotchas cho AI cần nhớ)
- **`maxConcurrency: 1`**: bắt buộc, không được tăng — FB block account khi thấy nhiều session song song.
- **`playwright: "*"`**: cố ý, để khớp browser bundle trong Docker base image; **không** dùng `npm ci`.
- **Diff mode = ID-based** (không phải timestamp) vì FB hay giấu timestamp trong feed.
- **GraphQL chỉ giữ `Map(id→time)`**, không buffer object lớn → tiết kiệm RAM (Apify tính tiền memory×time).
- **Webhook & moderation non-blocking**: lỗi không làm hỏng run.
- **Selectors trong `parser.js` sẽ vỡ ~1–2 tháng/lần** khi FB đổi DOM — đây là điểm bảo trì chính.
- **Một group = một record dataset** (kể cả khi lỗi → record có field `error`).

---

*Generated by Claude AI — reverse-engineered from source. Full source included (Section 15). Không chứa credential thật.*
