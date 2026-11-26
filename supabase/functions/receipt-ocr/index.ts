import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

interface ReqPayload {
  imageData: string;
}

// 사용할 모델 목록. 앞의 모델이 실패하면 다음 모델로 넘어갑니다.
// Supabase Secrets에 GEMINI_MODEL을 넣으면 첫 번째 모델을 코드 수정 없이 바꿀 수 있습니다.
const PRIMARY_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
const FALLBACK_MODEL = Deno.env.get("GEMINI_FALLBACK_MODEL") ||
  "gemini-3.5-flash-lite";
// 두 모델이 다 붐빌 때 마지막으로 써 볼 모델 (비워 두면 건너뜀)
const LAST_MODEL = Deno.env.get("GEMINI_LAST_MODEL") ?? "gemini-2.5-flash";
// 전체 처리 시간 상한. Supabase 함수 제한(150초)보다 넉넉히 짧게.
const TOTAL_BUDGET_MS = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 모델마다 허용하는 thinking_level 값이 다릅니다.
// 3.8 Flash: low 가능 / 3.5 Flash-Lite: minimal 가능 / 3.6 Flash: medium 이상만 가능
function thinkingLevelFor(model: string): string | null {
  if (model.includes("flash-lite")) return "minimal";
  if (model.startsWith("gemini-3.6")) return "medium";
  if (model.startsWith("gemini-2.")) return null; // 2.x는 thinking_level 미지원
  return "low";
}

// 모델 한 번 호출당 최대 대기 시간.
// 두 번 시도해도 Supabase 함수 제한 시간(150초) 안에 끝나도록 잡았습니다.
const REQUEST_TIMEOUT_MS = 45_000;

const prompt = `
당신은 가족 냉장고 앱의 장보기 기록 AI입니다.

첨부된 사진은 아래 셋 중 하나입니다. 먼저 어떤 사진인지 판단하세요.
- receipt: 마트·시장 종이 영수증
- order: 컬리, B마트(배민), 쿠팡, SSG 같은 온라인 장보기 앱의 주문 상세 화면 캡처
- photo: 장 본 재료나 냉장고 안을 찍은 실제 사진

[1단계: 영수증 줄을 그대로 옮기기 (receipt, order)]

상품 줄마다 영수증에 적힌 그대로 읽습니다. 계산은 하지 마세요. 계산은 앱이 합니다.
- original: 상품명 칸 글자 그대로 (앞의 *, # 같은 기호는 빼도 됩니다)
- qty: 수량 칸 숫자
- amount: 그 줄 오른쪽 끝 "금액" 칸 숫자 (단가가 아니라 금액. 단가 × 수량)
- discount: 그 상품 바로 아래에 붙은 할인 줄들의 금액 합을 양수로.
  할인 줄 모양: [L_할인] 40% -7,714 / [M+N] 1+1덤 -12,980 / [번들] 50% -2,700 /
  행사할인, 쿠폰, 즉시할인, 카드할인(상품 바로 아래에 있을 때) 등. 없으면 0.
  할인 줄은 절대 따로 상품으로 넣지 않습니다.
- 영수증 맨 아래 쪽 "자사할인", "에누리", "단수할인", "할인 상세내역"은 이미 위 상품 할인 줄을
  다시 모은 것이니 상품에 또 빼지 마세요.

영수증 아래쪽 숫자:
- total: 실제로 낸 돈. "결제금액", "받을금액", "청구액", "카드 승인금액", "총 결제금액" 중 하나.
  "합계", "판매합계"는 할인 전 금액일 때가 많으니 결제금액이 따로 있으면 결제금액을 씁니다.
  "면세 물품가액", "과세 물품가액", "부가세"는 total이 아닙니다.
  보이지 않으면 0. 사진(photo)이면 0.
- store: 가게·쇼핑몰 이름을 짧게 (예: 롯데마트, 이마트, 동네마트, 컬리). 모르면 빈 문자열.
- purchaseDate: 영수증·주문 화면의 날짜. 날짜에 연도가 없으면(예: 10.13(화)) 오늘 기준 가장 가까운 지난 날짜의 연도.

[2단계: 넣을 것과 뺄 것]

items에 넣는 것: 먹고 마시는 모든 것
  채소·과일·고기·생선·유제품·계란·두부, 밥·면·빵, 장류·소스·양념, 과자·간식·견과,
  음료·커피·우유·주스·생수, 술(맥주·소주·와인), 냉동식품, 즉석식품.
items에서 빼는 것: 먹는 것이 아닌 물건
  봉투(재사용봉투, 종량제봉투, 쇼핑백), 휴지, 세제, 주방용품, 생활용품, 배송비, 포장비.
  뺀 물건은 others에 {"original": 상품명, "amount": 금액, "discount": 할인} 로 따로 적습니다.
카페·식당의 즉석 메뉴(아메리카노, 라떼 등)는 넣지 않습니다.
order 화면: 취소·품절 상품은 빼고, 상품명 아래 회색으로 한 번 더 나오는 옵션명은 같은 상품이라 따로 넣지 않습니다.
  "1.5KG+300G"처럼 덤이 붙은 묶음은 상품 하나(qty 1)로 넣습니다.
photo: 사진에서 분명히 알아볼 수 있는 식재료만 넣습니다. 개수는 보이는 만큼 셉니다.
  amount, discount는 0, purchaseDate는 빈 문자열.

[3단계: 이름 정리]

name은 요리할 때 부르는 일반 이름으로 씁니다.
- 브랜드, 대괄호 [ ], 원산지(미국산, 국내산), 등급, 용량·중량, 개수, 광고 문구는 뺍니다.
- 영수증 상품명은 칸이 좁아 끝이 잘려 있습니다. 잘린 글자를 알맞게 채워 읽으세요.
  예: "풀무원다논 그릭 무가" → 그릭요거트 / "서울우유 포리커피 컵" → 커피우유 /
      "오뚜기 맛있는밥" → 즉석밥 / "크라운 참크래커 2번" → 크래커 / "사조 참치액" → 참치액 /
      "미국산 돼지 삼겹살" → 삼겹살 / "아사히 수퍼드라이 생" → 맥주 / "삿포로 (캔)" → 맥주 /
      "오리온 눈을감자" → 감자칩 / "달보드레쌀 4kg" → 쌀 / "[해찬들] 태양초 고추장" → 고추장 /
      "서울우유 1L" → 우유 / "특란 15구" → 계란 / "한돈 앞다리살 600g" → 돼지고기 앞다리살
- 요리에서 구분이 필요한 종류(앞다리살, 방울토마토, 다진마늘, 참송이버섯 등)는 남깁니다.
- 영수증 글자로 무엇인지 도저히 알 수 없으면 original을 짧게 줄여 name으로 씁니다. 빼지 마세요.
- 수량·단위: 영수증 수량 칸이 2면 qty 2. "15구"처럼 이름에 개수가 있으면 qty 15, unit "개".
  1+1은 받은 개수(보통 2)를 qty로 씁니다.

[4단계: 보관 정보]

- category: 채소, 과일, 육류, 유제품, 기타 중 하나 (계란은 유제품, 생선·해산물은 육류, 과자·음료·술·장류는 기타)
- location: 냉장, 냉동, 실온, 김치냉장고 중 하나
- shelfDays: 산 날부터 며칠 안에 먹으면 되는지 숫자. 예: 두부 5, 우유 10, 대파 10, 계란 30, 고추장 180, 쌀 365, 과자 90, 맥주 365.
  날짜를 직접 계산하지 마세요. 추정이 매우 어려우면 0.
- expiry: 포장에 인쇄된 날짜가 또렷하게 보일 때만 YYYY-MM-DD, 아니면 빈 문자열.
- emoji: 그 재료에 맞는 이모지 하나.

[규칙]
- 사진에 없는 상품이나 숫자를 만들어내지 마세요.
- 숫자는 쉼표 없이 숫자로. 날짜는 YYYY-MM-DD.
- 먹을 것이 하나도 없으면 items는 빈 배열.

[반환 형식]

마크다운이나 설명 없이 아래 JSON만 출력하세요. (예시 값은 형식 설명용입니다)

{
  "source": "receipt",
  "store": "롯데마트",
  "purchaseDate": "2026-05-01",
  "total": 100250,
  "others": [
    { "original": "재사용봉투(20L) 낱", "amount": 1740, "discount": 0 }
  ],
  "items": [
    {
      "name": "삼겹살",
      "original": "미국산 돼지 삼겹살",
      "category": "육류",
      "location": "냉장",
      "qty": 1,
      "unit": "팩",
      "amount": 19285,
      "discount": 7714,
      "shelfDays": 3,
      "expiry": "",
      "emoji": "🥓"
    },
    {
      "name": "참치액",
      "original": "사조 참치액",
      "category": "기타",
      "location": "냉장",
      "qty": 2,
      "unit": "병",
      "amount": 25960,
      "discount": 12980,
      "shelfDays": 180,
      "expiry": "",
      "emoji": "🫙"
    }
  ]
}
`;

console.info("receipt-ocr function started");

class HttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// 다음 모델로 넘어가도 되는 실패인지 표시
class AttemptError extends HttpError {
  retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message, status);
    this.retryable = retryable;
  }
}

function buildRequestBody(
  model: string,
  mimeType: string,
  base64Data: string,
): string {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    // 생각(thinking) 토큰도 이 한도에 포함될 수 있어 넉넉하게 잡습니다.
    // 너무 작으면 JSON이 중간에 잘려서 "결과를 읽을 수 없습니다" 오류가 납니다.
    maxOutputTokens: 8192,
  };

  const level = thinkingLevelFor(model);
  if (level) {
    generationConfig.thinkingConfig = { thinkingLevel: level };
  }

  return JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          },
          { text: `오늘 날짜(한국 시간): ${todayInKorea()}. 연도를 판단할 때 이 날짜를 기준으로 하세요.\n` + prompt },
        ],
      },
    ],
    generationConfig,
  });
}

// 모델 한 번 호출. 성공하면 모델이 돌려준 텍스트를 반환합니다.
async function callGemini(
  model: string,
  apiKey: string,
  mimeType: string,
  base64Data: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<string> {
  const apiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  let response: Response;
  let aiData: any;

  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: buildRequestBody(model, mimeType, base64Data),
      signal: controller.signal,
    });

    const responseText = await response.text();

    try {
      aiData = JSON.parse(responseText);
    } catch {
      aiData = { error: { message: responseText.slice(0, 1000) } };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error(`[${model}] 시간 초과 (${timeoutMs}ms)`);
      throw new AttemptError(
        "AI 분석 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.",
        504,
        true,
      );
    }

    console.error(`[${model}] 네트워크 오류:`, error);
    throw new AttemptError(
      "Gemini 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      502,
      true,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  console.info(
    `[${model}] 응답 ${response.status}, ${Date.now() - startedAt}ms`,
  );

  if (!response.ok) {
    const status = response.status;
    const detail = aiData?.error?.message || "상세 오류 없음";
    console.error(`[${model}] Gemini API 오류 ${status}:`, detail);

    if (status === 400) {
      // 요청 형식 문제. 다른 모델은 형식을 받아줄 수 있으니 넘어갑니다.
      throw new AttemptError(
        `Gemini 요청 형식 오류: ${detail}`,
        502,
        true,
      );
    }
    if (status === 401 || status === 403) {
      throw new AttemptError(
        "Gemini API 키가 올바르지 않거나 이 모델을 쓸 권한이 없습니다.",
        502,
        true,
      );
    }
    if (status === 404) {
      throw new AttemptError(
        `Gemini 모델(${model})을 찾을 수 없습니다.`,
        502,
        true,
      );
    }
    if (status === 429) {
      throw new AttemptError(
        "Gemini API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
        429,
        true,
      );
    }
    throw new AttemptError(
      "Gemini 서버가 현재 혼잡합니다. 잠시 후 다시 시도해 주세요.",
      503,
      status >= 500,
    );
  }

  const candidate = aiData.candidates?.[0];
  const outputText = (candidate?.content?.parts || [])
    .filter((part: any) => typeof part.text === "string" && !part.thought)
    .map((part: any) => part.text)
    .join("")
    .trim();

  if (candidate?.finishReason === "MAX_TOKENS") {
    console.error(`[${model}] 출력 한도 초과로 응답이 잘림`);
    throw new AttemptError(
      "항목이 너무 많아 분석이 중간에 끊겼습니다. 사진을 나눠서 찍어 주세요.",
      502,
      true,
    );
  }

  if (!outputText) {
    console.error(
      `[${model}] 빈 응답, finishReason=${candidate?.finishReason}`,
    );
    throw new AttemptError(
      "AI 분석 결과가 비어 있습니다. 사진을 다시 찍어 주세요.",
      502,
      true,
    );
  }

  return outputText;
}

// 소비기한: 포장에 찍힌 날짜(앞뒤 3년 안)면 그대로, 아니면 구매일 + shelfDays
function expiryFor(item: any, purchaseDate: string, today: string): string {
  if (isDate(item.expiry)) {
    const d = daysBetween(today, item.expiry);
    if (d > -60 && d < 1100) return item.expiry;
  }
  const days = Math.round(Number(item.shelfDays));
  if (Number.isFinite(days) && days > 0 && days <= 1100) return addDays(purchaseDate, days);
  return "";
}

const allowedCategories = ["채소", "과일", "육류", "유제품", "기타"];
const allowedLocations = ["냉장", "냉동", "실온", "김치냉장고"];

function todayInKorea(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000,
  );
}


// "12,980" · "-7,714원" 같은 글자도 숫자로 읽어요 (음수는 0)
function toWon(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// 할인 줄·먹는 것이 아닌 물건이 상품으로 들어오면 걸러요
const DISCOUNT_LINE = /^\s*\[?\s*(L_?할인|M\s*\+\s*N|번들|행사|에누리|쿠폰|즉시할인|카드할인|할인)|1\+1\s*덤|^\s*-?\s*\d+\s*%\s*$/;
const NOT_FOOD = /(재사용|종량제|비닐|쇼핑)\s*봉투|^봉투$|쇼핑백|배송비|포장비|휴지|물티슈|세제|키친타올|쿠킹호일|건전지/;

// AI가 준 상품 줄을 정리하고 값(할인 뺀 금액)을 계산해요
// 영수증 전체 금액(할인 전)과 할인 합도 같이 세어 둬요. 합계를 할인 전 숫자로 읽었을 때 바로잡는 데 써요.
function cleanItems(raw: any[]): { items: any[]; gross: number; discounts: number } {
  const out: any[] = [];
  let gross = 0, discounts = 0;
  for (const item of raw) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) continue;
    const text = `${item.original || ""} ${item.name}`;
    const amount = toWon(item.amount);
    const signed = Number(String(item.amount ?? item.price ?? "").replace(/[^0-9.-]/g, ""));
    // 할인 줄이 따로 들어오면 바로 앞 상품 값에서 빼요
    if (DISCOUNT_LINE.test(item.original || "") || DISCOUNT_LINE.test(item.name) || signed < 0) {
      const prev = out[out.length - 1];
      const d = Math.abs(signed) || toWon(item.discount);
      discounts += d;
      if (prev) prev._discount += d;
      continue;
    }
    gross += amount || toWon(item.price);
    discounts += toWon(item.discount);
    if (NOT_FOOD.test(text.replace(/\s+/g, " "))) continue;
    out.push({ ...item, _amount: amount, _discount: toWon(item.discount), _legacyPrice: toWon(item.price) });
  }
  for (const it of out) {
    // amount(할인 전)가 있으면 앱이 직접 빼고, 예전 형식(price만)이면 그대로 써요
    const base = it._amount || it._legacyPrice;
    it._price = Math.max(0, base - Math.min(it._discount, base));
  }
  return { items: out, gross, discounts };
}

const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function normalize(parsed: any) {
  const today = todayInKorea();
  // 구매일: 1년 넘게 지났거나 미래 날짜면 AI가 연도를 잘못 본 것이라 오늘로 바꿉니다.
  let purchaseDate = isDate(parsed.purchaseDate) ? parsed.purchaseDate : today;
  const ago = daysBetween(purchaseDate, today);
  if (ago < 0 || ago > 365) purchaseDate = today;

  const source = ["receipt", "order", "photo"].includes(parsed.source)
    ? parsed.source
    : "receipt";
  const cleaned = cleanItems(Array.isArray(parsed.items) ? parsed.items : []);
  // 먹는 것이 아닌 물건: 이름만 앱에 넘기고, 금액은 할인 전 합계 확인에 써요
  const others: string[] = [];
  for (const o of Array.isArray(parsed.others) ? parsed.others : []) {
    const name = String(o?.original || o?.name || "").replace(/^[*#\s]+/, "").replace(/\(.*?\)|\s*낱$/g, "").trim();
    if (name && others.length < 5 && !others.includes(name)) others.push(name.slice(0, 20));
    cleaned.gross += toWon(o?.amount);
    cleaned.discounts += toWon(o?.discount);
  }
  const items = cleaned.items
    .map((item: any) => ({
      name: item.name.trim().slice(0, 100),
      original: typeof item.original === "string" ? item.original.trim().slice(0, 150) : "",
      category: allowedCategories.includes(item.category)
        ? item.category
        : "기타",
      location: allowedLocations.includes(item.location)
        ? item.location
        : "냉장",
      qty: Number.isFinite(Number(item.qty)) && Number(item.qty) > 0
        ? Number(item.qty)
        : 1,
      unit: typeof item.unit === "string" && item.unit.trim()
        ? item.unit.trim().slice(0, 20)
        : "개",
      expiry: expiryFor(item, purchaseDate, today),
      emoji: typeof item.emoji === "string" && item.emoji
        ? item.emoji.slice(0, 8)
        : "🥬",
      price: source === "photo" ? 0 : item._price,
    }));

  // 영수증 합계: 사진(photo)은 합계가 없어요.
  // 재료값 합보다 조금 작으면 앱이 "가격을 한 번 봐 주세요"라고 알려 주니 그대로 두고,
  // 절반도 안 되면 잘못 읽은 숫자라 버려요.
  const itemSum = items.reduce((sum: number, it: any) => sum + it.price, 0);
  let total = toWon(parsed.total);
  // "합계"(할인 전)를 결제금액으로 잘못 읽었으면 할인만큼 빼요
  if (cleaned.discounts > 0 && Math.abs(total - cleaned.gross) <= 10) total -= cleaned.discounts;
  if (source === "photo" || total < itemSum * 0.5 || total > 10_000_000) total = 0;
  const store = source !== "photo" && typeof parsed.store === "string"
    ? parsed.store.trim().slice(0, 30)
    : "";

  return { source, purchaseDate, store, total, others: source === "photo" ? [] : others, items };
}

export default {
  fetch: withSupabase(
    { auth: "user" },
    async (req, _ctx) => {
      try {
        if (req.method !== "POST") {
          throw new HttpError("POST 요청만 허용됩니다.", 405);
        }

        const apiKey = Deno.env.get("GEMINI_API_KEY");
        if (!apiKey) {
          throw new HttpError("Gemini API 키가 설정되지 않았습니다.", 500);
        }

        const { imageData }: ReqPayload = await req.json();

        if (typeof imageData !== "string" || !imageData.startsWith("data:image/")) {
          throw new HttpError("사진 형식이 올바르지 않습니다.", 400);
        }
        if (imageData.length > 12_000_000) {
          throw new HttpError("이미지 용량이 너무 큽니다.", 413);
        }

        const match = imageData.match(
          /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s,
        );
        if (!match) {
          throw new HttpError("지원하지 않는 이미지 형식입니다.", 400);
        }

        const mimeType = match[1];
        const base64Data = match[2];
        console.info(`영수증 이미지 확인: ${mimeType}, ${base64Data.length}자`);

        // 기본 모델 → 실패하면 예비 모델 순서로 시도
        // 붐빔(503)·한도(429)는 같은 모델로 한 번 더 시도한 뒤 다음 모델로 넘어가요.
        const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL, LAST_MODEL].filter(Boolean))];
        const attempts: string[] = [];
        models.forEach((m, i) => { attempts.push(m); if (i < 2) attempts.push(m); });
        const startedAll = Date.now();
        let lastError: HttpError | null = null;
        let prevModel = "";

        for (const model of attempts) {
          const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAll);
          if (remaining < 12_000) break;
          // 같은 모델 재시도는 바로 앞이 붐빔/한도였을 때만
          if (model === prevModel) {
            if (!(lastError && [429, 503].includes(lastError.status))) continue;
            await sleep(1500);
          }
          prevModel = model;
          try {
            const outputText = await callGemini(
              model,
              apiKey,
              mimeType,
              base64Data,
              Math.min(REQUEST_TIMEOUT_MS, remaining - 5_000),
            );

            const cleanedText = outputText
              .replace(/^```json\s*/i, "")
              .replace(/\s*```$/, "")
              .trim();

            let parsed: any;
            try {
              parsed = JSON.parse(cleanedText);
            } catch {
              throw new AttemptError(
                "AI 분석 결과를 읽을 수 없습니다. 다시 촬영해 주세요.",
                502,
                true,
              );
            }

            if (!parsed || !Array.isArray(parsed.items)) {
              throw new AttemptError(
                "AI 분석 결과 형식이 올바르지 않습니다.",
                502,
                true,
              );
            }

            const result = normalize(parsed);
            console.info(`[${model}] 분석 완료: ${result.items.length}개 상품`);
            return Response.json({ ...result, model });
          } catch (error) {
            if (error instanceof AttemptError && error.retryable) {
              lastError = error;
              console.warn(`[${model}] 실패(${error.status}), 다시 시도하거나 다음 모델로 넘어갑니다.`);
              continue;
            }
            throw error;
          }
        }

        throw lastError ||
          new HttpError("사진 분석에 실패했습니다. 다시 시도해 주세요.", 502);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error
          ? error.message
          : "사진 분석 중 오류가 발생했습니다.";

        console.error(`Receipt OCR error (${status}):`, message);
        return Response.json({ error: message }, { status });
      }
    },
  ),
};
