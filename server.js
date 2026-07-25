// LIFE ROAD 시세 서버 (option ①)
// 대시보드가 이 서버의 /quotes 를 호출하면, 종목별 현재가와 환율을 돌려줍니다.
// 시세 출처: Yahoo Finance (무료, API 키 불필요). 서버에서 호출하므로 CORS/키 문제 없음.
//
// 실행:  npm install  &&  npm start
// 기본 포트 8787 (환경변수 PORT 로 변경 가능)

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());                 // 모든 출처 허용 → 대시보드(브라우저)에서 호출 가능
app.use(express.json({ limit: "8mb" }));  // 백업 데이터(JSON) 수신용

/* ------------------------------------------------------------------ *
 *  종목 매핑 — 대시보드의 "종목명"을 시세 심볼에 연결합니다.
 *  symbol : Yahoo Finance 심볼
 *           · 미국 ETF/주식  → 그대로 (TLT, VOO ...)
 *           · 국내 상장 ETF   → 코드 + ".KS"  (예: TIGER 미국S&P500 = "360750.KS")
 *  quote  : 그 심볼이 매겨지는 통화 ("USD" | "KRW")
 *  out    : 대시보드가 저장하는 통화 ("USD" | "KRW")
 *           quote≠out 이면 환율로 환산해서 돌려줍니다.
 *
 *  ※ 비상장 펀드(연금 S&P500 펀드, BANK, MMF 등)는 Yahoo로 조회되지 않습니다.
 *    상장 ETF 코드를 아시면 아래에 추가하시고, 펀드는 수동 입력으로 두세요.
 * ------------------------------------------------------------------ */
const MAP = {
  // 해외 ETF (Yahoo Finance, 심볼)
  "TLT": { source: "yahoo", symbol: "TLT", quote: "USD", out: "KRW" },
  "VOO": { source: "yahoo", symbol: "VOO", quote: "USD", out: "KRW" },

  // 국내 상장 ETF (네이버 금융, 종목코드) — alphanumeric 코드도 지원
  "S&P500":           { source: "naver", code: "379800", out: "KRW" }, // KODEX 미국S&P500
  "S&P500 & 10 BOND": { source: "naver", code: "0080X0", out: "KRW" }, // SOL 미국S&P500미국채혼합50

  "MMF":              { source: "naver", code: "488770", out: "KRW" }, // KODEX 머니마켓액티브 (398주)

  "KOSPI":            { source: "naver", code: "069500", out: "KRW" }, // KODEX 200 (코스피)

  // 자산(우리사주) — 보유주식수 × 이 주가로 대시보드가 평가액을 계산합니다.
  "우리사주":          { source: "naver", code: "003690", out: "KRW" }, // 코리안리재보험

  // BANK · 미국 국채(특정 채권) 는 단일 공개 시세가 없어 자동 대상 제외 → 대시보드에서 수동.
};

// 네이버 금융 현재가 (국내 상장 ETF/주식)
async function naver(code) {
  const tries = [
    `https://m.stock.naver.com/api/stock/${code}/basic`,
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`,
  ];
  for (const url of tries) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com/" } });
      if (!r.ok) continue;
      const j = await r.json();
      const d = j?.datas?.[0] || j;
      const num = (v) => { const p = parseFloat(String(v ?? "").replace(/,/g, "")); return p > 0 ? p : null; };
      const cur = num(d.closePrice);
      // 전일종가: 네이버가 직접 주면 사용, 없으면 현재가 − 등락폭으로 역산
      let prev = num(d.previousClose) ?? num(d.prevClosePrice);
      if (prev == null && cur != null) {
        const diff = parseFloat(String(d.compareToPreviousClosePrice ?? d.changeValue ?? "").replace(/,/g, ""));
        const sign = (String(d.compareToPreviousPrice?.code ?? d.risingType ?? "").includes("5") ||
                      String(d.compareToPreviousClosePrice ?? "").startsWith("-")) ? -1 : 1;
        if (!isNaN(diff) && diff !== 0) prev = cur - Math.abs(diff) * sign;
      }
      if (cur != null) return { price: cur, prevClose: prev ?? cur };
    } catch (e) { /* try next */ }
  }
  return null;
}

// Yahoo Finance 현재가 + 전일종가 조회
async function yahoo(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    const p = meta?.regularMarketPrice;
    if (typeof p !== "number" || p <= 0) return null;
    // 전일종가: chartPreviousClose/previousClose, 없으면 종가 시계열의 직전 값
    let prev = meta?.chartPreviousClose ?? meta?.previousClose;
    const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if ((prev == null || prev <= 0) && Array.isArray(closes)) {
      const valid = closes.filter((x) => typeof x === "number" && x > 0);
      if (valid.length >= 2) prev = valid[valid.length - 2];
    }
    return { price: p, prevClose: (typeof prev === "number" && prev > 0) ? prev : p };
  } catch (e) {
    return null;
  }
}
// 환율 등 단일 값만 필요할 때
async function yahooPrice(symbol) { const q = await yahoo(symbol); return q ? q.price : null; }

app.get("/", (_req, res) => res.send("LIFE ROAD price server OK. Try /quotes"));

app.get("/quotes", async (_req, res) => {
  try {
    // USD/KRW 환율
    const fx = (await yahooPrice("KRW=X")) || (await yahooPrice("USDKRW=X"));
    const quotes = {};
    const prevQuotes = {};
    for (const [name, cfg] of Object.entries(MAP)) {
      const q = cfg.source === "naver" ? await naver(cfg.code) : await yahoo(cfg.symbol);
      if (q == null) continue;
      const conv = (px) => {
        let val = px;
        if (cfg.quote === "USD" && cfg.out === "KRW") val = px * (fx || 0);
        if (cfg.quote === "KRW" && cfg.out === "USD") val = fx ? px / fx : px;
        return val;
      };
      const val = conv(q.price);
      const prevVal = conv(q.prevClose);
      if (val > 0) {
        quotes[name] = Math.round(val);
        prevQuotes[name] = Math.round(prevVal > 0 ? prevVal : val);
      }
    }
    res.json({ fx: fx ? Math.round(fx) : null, asof: new Date().toISOString(), quotes, prevQuotes });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ------------------------------------------------------------------ *
 *  자동 백업 — 대시보드 데이터를 회원님의 비공개 GitHub 저장소에 저장.
 *  Render 환경변수(Environment)에서 아래를 설정하세요:
 *    GH_TOKEN    : GitHub Personal Access Token (백업 저장소 Contents 읽기/쓰기)
 *    GH_REPO     : "사용자명/백업저장소"  예: "lawyerjwl/jw-backup"  (반드시 비공개!)
 *    GH_PATH     : (선택) 저장 파일 경로. 기본 "liferoad-backup.json"
 *    BACKUP_KEY  : 백업 접근 비밀번호(아무 문자열). 대시보드 설정에도 같은 값 입력.
 * ------------------------------------------------------------------ */
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO;
const GH_PATH = process.env.GH_PATH || "liferoad-backup.json";
const BACKUP_KEY = process.env.BACKUP_KEY;

function backupReady(res) {
  if (!GH_TOKEN || !GH_REPO || !BACKUP_KEY) { res.status(503).json({ error: "backup not configured (GH_TOKEN/GH_REPO/BACKUP_KEY 필요)" }); return false; }
  return true;
}
function authOK(req, res) {
  const k = req.query.key || req.get("x-backup-key");
  if (k !== BACKUP_KEY) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}
const GH_HEAD = () => ({ Authorization: `Bearer ${GH_TOKEN}`, "User-Agent": "liferoad", Accept: "application/vnd.github+json" });
const GH_INBOX = process.env.GH_INBOX || "liferoad-inbox.json";

async function ghGet(path = GH_PATH) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`, { headers: GH_HEAD() });
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) throw new Error("github get " + r.status);
  const j = await r.json();
  return { content: Buffer.from(j.content, "base64").toString("utf8"), sha: j.sha };
}
async function ghPut(text, sha, path = GH_PATH) {
  const body = { message: "liferoad " + path + " " + new Date().toISOString(), content: Buffer.from(text, "utf8").toString("base64") };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method: "PUT", headers: { ...GH_HEAD(), "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("github put " + r.status + " " + (await r.text()));
}

app.get("/backup", async (req, res) => {
  if (!backupReady(res)) return; if (!authOK(req, res)) return;
  try { const { content } = await ghGet(); res.json({ data: content ? JSON.parse(content) : null }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post("/backup", async (req, res) => {
  if (!backupReady(res)) return; if (!authOK(req, res)) return;
  try { const { sha } = await ghGet(); await ghPut(JSON.stringify(req.body || {}), sha); res.json({ ok: true, at: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

/* ------------------------------------------------------------------ *
 *  수신함(inbox) — 안드로이드 앱이 보낸 거래를 보관했다가 웹이 가져갑니다.
 *  POST /inbox        { items: [거래...] }  → 기존 수신함에 이어붙임
 *  GET  /inbox                              → { items: [...] }
 *  POST /inbox/clear                        → 수신함 비움 (웹이 반영 후 호출)
 * ------------------------------------------------------------------ */
app.get("/inbox", async (req, res) => {
  if (!backupReady(res)) return; if (!authOK(req, res)) return;
  try { const { content } = await ghGet(GH_INBOX); res.json({ items: content ? JSON.parse(content) : [] }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post("/inbox", async (req, res) => {
  if (!backupReady(res)) return; if (!authOK(req, res)) return;
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "items required" });
    const cur = await ghGet(GH_INBOX);
    const list = cur.content ? JSON.parse(cur.content) : [];
    const merged = [...list, ...items];
    await ghPut(JSON.stringify(merged), cur.sha, GH_INBOX);
    res.json({ ok: true, queued: merged.length });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post("/inbox/clear", async (req, res) => {
  if (!backupReady(res)) return; if (!authOK(req, res)) return;
  try { const cur = await ghGet(GH_INBOX); await ghPut("[]", cur.sha, GH_INBOX); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log("LIFE ROAD price server listening on :" + port));
