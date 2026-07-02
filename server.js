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
      const raw = j.closePrice ?? j?.datas?.[0]?.closePrice;
      const p = parseFloat(String(raw || "").replace(/,/g, ""));
      if (p > 0) return p;
    } catch (e) { /* try next */ }
  }
  return null;
}

// Yahoo Finance 현재가 조회
async function yahoo(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === "number" && p > 0 ? p : null;
  } catch (e) {
    return null;
  }
}

app.get("/", (_req, res) => res.send("LIFE ROAD price server OK. Try /quotes"));

app.get("/quotes", async (_req, res) => {
  try {
    // USD/KRW 환율
    const fx = (await yahoo("KRW=X")) || (await yahoo("USDKRW=X"));
    const quotes = {};
    for (const [name, cfg] of Object.entries(MAP)) {
      const px = cfg.source === "naver" ? await naver(cfg.code) : await yahoo(cfg.symbol);
      if (px == null) continue;
      let val = px;
      if (cfg.quote === "USD" && cfg.out === "KRW") val = px * (fx || 0);
      if (cfg.quote === "KRW" && cfg.out === "USD") val = fx ? px / fx : px;
      if (val > 0) quotes[name] = Math.round(val);
    }
    res.json({ fx: fx ? Math.round(fx) : null, asof: new Date().toISOString(), quotes });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log("LIFE ROAD price server listening on :" + port));
