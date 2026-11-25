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
당신은 가족 냉장고 앱의 식재료 등록 AI입니다.

첨부된 사진은 아래 셋 중 하나입니다. 먼저 어떤 사진인지 판단하고 식품 및 식재료 항목만 추출하세요.
- receipt: 마트·시장 종이 영수증
- order: 컬리, B마트(배민), 쿠팡, SSG 같은 온라인 장보기 앱의 주문 상세 화면 캡처
- photo: 장 본 재료나 냉장고 안을 찍은 실제 사진

[사진 종류별 규칙]

A. receipt: 영수증에 인쇄된 상품명을 알아보기 쉽게 정리합니다.
B. order: 화면에 보이는 상품명에서 브랜드·광고 문구·용량 표기는 줄이고 재료 이름이 드러나게 정리합니다.
   예: "[KF365] 1+등급 무항생제 신선한 대란 20구" → 이름 "계란", 수량 20, 단위 "개"
   주문 수량(예: 2개, 수량 2)은 qty에 반영합니다. 배송비, 쿠폰, 포장재, 합계 줄은 제외합니다.
   취소·품절된 상품은 제외합니다. 주문일이나 배송완료일이 보이면 purchaseDate로 씁니다.
   날짜에 연도가 없으면(예: 10.13(화)) 오늘 기준 가장 가까운 지난 날짜의 연도를 붙입니다.
   상품명 아래 회색 글씨로 한 번 더 나오는 옵션명(예: "달보드레쌀 4kg (26년 햅쌀)")은 같은 상품이니 따로 넣지 않습니다.
   "1.5KG+300G"처럼 덤이 붙은 묶음은 상품 하나(qty 1)로 넣습니다.
   쌀, 장류, 청, 소스처럼 오래 두고 먹는 것도 식재료로 넣고, 보관 위치는 실온(개봉 후 냉장이 맞는 장류·소스는 냉장)으로 추천합니다.
C. photo: 사진에서 분명히 알아볼 수 있는 식재료만 넣습니다. 확실하지 않은 것은 넣지 않습니다.
   이름은 일반적인 재료 이름(예: 양파, 두부, 우유)으로 씁니다. 개수는 보이는 만큼 셉니다.
   포장에 날짜가 또렷하게 인쇄되어 보이면 그 날짜를 expiry로 씁니다.
   price는 0, purchaseDate는 빈 문자열로 둡니다.

[공통 규칙]

1. name은 브랜드·상품명이 아닌 요리할 때 부르는 일반 재료 이름으로 씁니다.
   브랜드, 대괄호 [ ], 등급, 용량·중량, 개수, 원산지, 광고 문구는 모두 뺍니다.
   예: 달보드레쌀 4kg → 쌀 / [청정원] 매실청 650g → 매실청 / [해찬들] 100% 태양초 우리쌀 고추장 → 고추장
       [몬] 스위트 칠리소스 → 칠리소스 / 서울우유 1L → 우유 / 국산콩두부 300g → 두부 / 특란 15구 → 계란
       한돈 앞다리살 600g → 돼지고기 앞다리살 / 무농약 시금치 → 시금치
   요리에서 구분이 필요한 종류(앞다리살, 방울토마토, 다진마늘 등)는 남깁니다.
   원래 상품명 전체는 original에 그대로 넣습니다.
2. 식품 및 식재료가 아닌 상품은 제외합니다.
3. 카페와 식당의 즉석 제조 메뉴는 제외합니다.
   예: 아메리카노, 플랫화이트, 라떼, 에이드 등
4. 우유, 원두, 커피 캡슐, 티백, 생수처럼
   별도로 보관하거나 소비하는 제품은 포함합니다.
5. 상품별 실제 구매 수량과 단위를 구분합니다.
6. 묶음 상품은 가능한 경우 구성 수량을 반영합니다.
7. 구매일은 영수증이나 주문 화면에 적힌 날짜를 사용합니다. 사진(photo)이면 빈 문자열입니다.
8. 상품별 카테고리를 다음 중 하나로 분류합니다.
   채소, 과일, 육류, 유제품, 기타
9. 보관 위치를 다음 중 하나로 추천합니다.
   냉장, 냉동, 실온, 김치냉장고
10. 상품 특성과 추천 보관 위치를 고려해, 산 날부터 며칠 안에 먹으면 되는지를
    shelfDays에 숫자(일)로 넣습니다. 예: 두부 5, 우유 10, 대파 10, 계란 30, 고추장 180, 쌀 365
    날짜를 직접 계산하지 말고 일수만 넣으세요. 날짜 계산은 앱이 합니다.
11. expiry는 포장에 인쇄된 날짜가 사진에 또렷하게 보일 때만 그 날짜를 넣고, 아니면 빈 문자열입니다.
12. 추정이 매우 어려운 경우에만 shelfDays를 0으로 둡니다.
13. 수량은 숫자로, 단위는 문자열로 반환합니다.
14. 날짜 형식은 반드시 YYYY-MM-DD로 반환합니다.
15. 사진에 없는 상품이나 정보를 만들어내지 마세요.
16. 식재료나 보관식품이 없다면 items를 빈 배열로 반환합니다.
17. 상품별 결제 금액(원, 할인 반영 후)을 price에 숫자로 넣습니다. 알 수 없으면 0입니다.

[반환 형식]

반드시 아래 JSON 형식으로만 답변하세요.
마크다운이나 별도 설명은 출력하지 마세요.

{
  "source": "receipt",
  "purchaseDate": "YYYY-MM-DD",
  "items": [
    {
      "name": "고추장",
      "original": "[해찬들] 100% 태양초 우리쌀 고추장 1.5KG+300G",
      "category": "채소",
      "location": "냉장",
      "qty": 1,
      "unit": "개",
      "shelfDays": 5,
      "expiry": "",
      "emoji": "🥬",
      "price": 3500
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

const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function normalize(parsed: any) {
  const today = todayInKorea();
  // 구매일: 1년 넘게 지났거나 미래 날짜면 AI가 연도를 잘못 본 것이라 오늘로 바꿉니다.
  let purchaseDate = isDate(parsed.purchaseDate) ? parsed.purchaseDate : today;
  const ago = daysBetween(purchaseDate, today);
  if (ago < 0 || ago > 365) purchaseDate = today;

  const items = parsed.items
    .filter((item: any) => typeof item?.name === "string" && item.name.trim())
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
      price: Number.isFinite(Number(item.price)) && Number(item.price) > 0
        ? Math.round(Number(item.price))
        : 0,
    }));

  const source = ["receipt", "order", "photo"].includes(parsed.source)
    ? parsed.source
    : "receipt";

  return { source, purchaseDate, items };
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
