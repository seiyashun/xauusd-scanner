const SYMBOL = "XAUTUSDT";
const FAPI_BASE = "https://fapi.binance.com";
const TIMEFRAMES = ["30m", "1h", "4h"];
const TF_LABELS = { "30m": "M30", "1h": "H1", "4h": "H4" };

let activeTf = "30m";
let cache = {};
let livePrice = null;

// --- API FETCH (BINANCE FUTURES PUBLIC DATA) ---
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url.split("?")[0]})`);
  return res.json();
}

async function fetchOrderFlow(period, limit = 6) {
  const [taker, topPos, retailAcc] = await Promise.all([
    fetchJson(`${FAPI_BASE}/futures/data/takerlongshortRatio?symbol=${SYMBOL}&period=${period}&limit=${limit}`),
    fetchJson(`${FAPI_BASE}/futures/data/topLongShortPositionRatio?symbol=${SYMBOL}&period=${period}&limit=${limit}`),
    fetchJson(`${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${SYMBOL}&period=${period}&limit=${limit}`)
  ]);

  const rows = taker.map((t, idx) => {
    const buyVol = parseFloat(t.buyVol);
    const sellVol = parseFloat(t.sellVol);
    const totalVol = buyVol + sellVol;
    const buyPct = totalVol > 0 ? (buyVol / totalVol) * 100 : 50;
    const takerRatio = parseFloat(t.buySellRatio);

    const topItem = topPos[idx] || topPos[topPos.length - 1];
    const retailItem = retailAcc[idx] || retailAcc[retailAcc.length - 1];

    const topLongPct = topItem ? parseFloat(topItem.longAccount) * 100 : 50;
    const retailLongPct = retailItem ? parseFloat(retailItem.longAccount) * 100 : 50;

    return {
      timestamp: t.timestamp,
      takerRatio,
      buyPct,
      sellPct: 100 - buyPct,
      topLongPct,
      retailLongPct,
      bias: classifyBias(takerRatio, topLongPct)
    };
  });

  const latest = rows[rows.length - 1];
  return {
    latest,
    history: rows.slice(-5).reverse()
  };
}

// --- SCORING ENGINE (ORDER FLOW + POSITIONING) ---
function classifyBias(takerRatio, topLongPct) {
  let score = 0;

  // 1. Lực mua/bán chủ động (Taker Volume)
  if (takerRatio >= 1.05) score += 1;
  else if (takerRatio <= 0.95) score -= 1;

  // 2. Vị thế dòng tiền lớn (Top Traders Position)
  if (topLongPct >= 52) score += 1;
  else if (topLongPct <= 48) score -= 1;

  if (score >= 1) {
    return {
      verdict: "BULLISH",
      shortLabel: "BULL",
      cssClass: "bull",
      reason: `Phe MUA áp đảo: Taker Buy/Sell đạt ${takerRatio.toFixed(2)} và Top Traders giữ ${topLongPct.toFixed(1)}% vị thế Long.`
    };
  }
  if (score <= -1) {
    return {
      verdict: "BEARISH",
      shortLabel: "BEAR",
      cssClass: "bear",
      reason: `Phe BÁN áp đảo: Taker Buy/Sell chỉ ${takerRatio.toFixed(2)} và Top Traders nghiêng Short (${(100 - topLongPct).toFixed(1)}%).`
    };
  }
  return {
    verdict: "SIDEWAY",
    shortLabel: "SIDEWAY",
    cssClass: "neutral",
    reason: `Lực BUY/SELL cân bằng hoặc mâu thuẫn giữa Taker (${takerRatio.toFixed(2)}) và Top Traders (${topLongPct.toFixed(1)}% Long).`
  };
}

// --- TRADINGVIEW TECHNICAL ANALYSIS WIDGET ---
function renderTradingViewWidget(interval) {
  const container = document.getElementById("tv-widget-container");
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "tradingview-widget-container";
  const widgetDiv = document.createElement("div");
  widgetDiv.className = "tradingview-widget-container__widget";
  wrapper.appendChild(widgetDiv);

  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-technical-analysis.js";
  script.async = true;
  script.textContent = JSON.stringify({
    interval: interval,
    width: "100%",
    isTransparent: true,
    height: 360,
    symbol: "OANDA:XAUUSD",
    showIntervalTabs: false,
    displayMode: "single",
    locale: "vi_VN",
    colorTheme: "dark"
  });

  wrapper.appendChild(script);
  container.appendChild(wrapper);
}

// --- RENDER UI ---
function formatTimeVN(ms) {
  return new Date(ms).toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit"
  });
}

function renderActiveView() {
  const data = cache[activeTf];
  if (!data) return;

  const { latest, history } = data;
  const tfName = TF_LABELS[activeTf];

  if (livePrice !== null) {
    document.getElementById("live-price").textContent = `$${livePrice.toFixed(2)}`;
  }

  document.getElementById("active-tf-label").textContent = tfName;
  document.getElementById("tv-tf-label").textContent = tfName;
  document.getElementById("table-tf-label").textContent = tfName;

  // Verdict badge
  const badge = document.getElementById("verdict-badge");
  badge.textContent =
    latest.bias.verdict === "BULLISH" ? "▲ BULL (PHE MUA ÁP ĐẢO)" :
    latest.bias.verdict === "BEARISH" ? "▼ BEAR (PHE BÁN ÁP ĐẢO)" :
    "◆ SIDEWAY (GIẰNG CO)";
  badge.className = `verdict-badge ${latest.bias.cssClass}`;
  document.getElementById("verdict-reason").textContent = latest.bias.reason;

  // Buy / Sell Ratio Bar
  document.getElementById("taker-buy-pct").textContent = `${latest.buyPct.toFixed(1)}%`;
  document.getElementById("taker-sell-pct").textContent = `${latest.sellPct.toFixed(1)}%`;
  document.getElementById("taker-buy-bar").style.width = `${latest.buyPct}%`;
  document.getElementById("taker-sell-bar").style.width = `${latest.sellPct}%`;

  // 3 Metric Cards
  document.getElementById("metric-taker").textContent = latest.takerRatio.toFixed(3);
  const takerStatus = document.getElementById("metric-taker-status");
  if (latest.takerRatio >= 1.05) {
    takerStatus.textContent = "Lực Mua chủ động mạnh (> 1.05)";
    takerStatus.className = "ind-status text-bull";
  } else if (latest.takerRatio <= 0.95) {
    takerStatus.textContent = "Lực Bán chủ động mạnh (< 0.95)";
    takerStatus.className = "ind-status text-bear";
  } else {
    takerStatus.textContent = "Cân bằng cung cầu (0.95 - 1.05)";
    takerStatus.className = "ind-status text-neutral";
  }

  document.getElementById("metric-top").textContent = `${latest.topLongPct.toFixed(1)}% L / ${(100 - latest.topLongPct).toFixed(1)}% S`;
  const topStatus = document.getElementById("metric-top-status");
  if (latest.topLongPct >= 52) {
    topStatus.textContent = "Cá mập nghiêng LONG";
    topStatus.className = "ind-status text-bull";
  } else if (latest.topLongPct <= 48) {
    topStatus.textContent = "Cá mập nghiêng SHORT";
    topStatus.className = "ind-status text-bear";
  } else {
    topStatus.textContent = "Cá mập trung lập";
    topStatus.className = "ind-status text-neutral";
  }

  document.getElementById("metric-retail").textContent = `${latest.retailLongPct.toFixed(1)}% L / ${(100 - latest.retailLongPct).toFixed(1)}% S`;
  const retailStatus = document.getElementById("metric-retail-status");
  if (latest.retailLongPct >= 65) {
    retailStatus.textContent = "Đám đông quá hưng phấn Long (Cảnh báo quét SL)";
    retailStatus.className = "ind-status text-neutral";
  } else if (latest.retailLongPct <= 35) {
    retailStatus.textContent = "Đám đông quá hoảng loạn Short (Cảnh báo bẫy)";
    retailStatus.className = "ind-status text-neutral";
  } else {
    retailStatus.textContent = "Tâm lý đám đông bình thường";
    retailStatus.className = "ind-status text-muted";
  }

  // History Table
  const tbody = document.getElementById("history-tbody");
  tbody.innerHTML = history.map(row => `
    <tr>
      <td>${formatTimeVN(row.timestamp)}</td>
      <td><strong>${row.takerRatio.toFixed(3)}</strong></td>
      <td class="${row.buyPct >= 50 ? "text-bull" : "text-bear"}">${row.buyPct.toFixed(1)}%</td>
      <td class="${row.topLongPct >= 50 ? "text-bull" : "text-bear"}">${row.topLongPct.toFixed(1)}%</td>
      <td>${row.retailLongPct.toFixed(1)}%</td>
      <td><span class="tag ${row.bias.cssClass}">${row.bias.shortLabel}</span></td>
    </tr>
  `).join("");
}

function renderMTF() {
  TIMEFRAMES.forEach(tf => {
    const el = document.getElementById(`mtf-${tf}`);
    const data = cache[tf];
    if (!el || !data) return;
    el.textContent = data.latest.bias.shortLabel;
    el.className = `tag ${data.latest.bias.cssClass}`;
  });
}

// --- MAIN LOOP ---
async function updateAll() {
  const errEl = document.getElementById("error-banner");
  errEl.classList.add("hidden");

  try {
    const [priceData, ...tfResults] = await Promise.all([
      fetchJson(`${FAPI_BASE}/fapi/v1/ticker/price?symbol=${SYMBOL}`),
      ...TIMEFRAMES.map(async tf => [tf, await fetchOrderFlow(tf, 6)])
    ]);

    livePrice = parseFloat(priceData.price);
    tfResults.forEach(([tf, data]) => {
      cache[tf] = data;
    });

    renderMTF();
    renderActiveView();
    document.getElementById("last-updated").textContent =
      `Cập nhật lúc ${new Date().toLocaleTimeString("vi-VN")}`;
  } catch (err) {
    errEl.textContent = `Lỗi lấy dữ liệu Order Flow: ${err.message}. Kiểm tra mạng hoặc thử lại.`;
    errEl.classList.remove("hidden");
  }
}

// --- EVENTS ---
document.getElementById("tf-buttons").addEventListener("click", e => {
  const btn = e.target.closest(".tf-btn");
  if (!btn) return;
  document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  activeTf = btn.dataset.tf;
  renderActiveView();
  renderTradingViewWidget(activeTf);
});

document.getElementById("refresh-btn").addEventListener("click", () => {
  updateAll();
  renderTradingViewWidget(activeTf);
});

// Init
updateAll();
renderTradingViewWidget(activeTf);
setInterval(updateAll, 60000);
