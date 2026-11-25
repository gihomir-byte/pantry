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
당신은 한국 마트 영수증을 분석하는 식재료 관리 AI입니다.

첨부된 영수증 이미지를 분석하고 식품 및 식재료 구매 항목만 추출하세요.

[분석 규칙]

1. 영수증에 인쇄된 상품명을 알아보기 쉽게 정리합니다.
2. 식품 및 식재료가 아닌 상품은 제외합니다.
3. 카페와 식당의 즉석 제조 메뉴는 제외합니다.
   예: 아메리카노, 플랫화이트, 라떼, 에이드 등
4. 우유, 원두, 커피 캡슐, 티백, 생수처럼
   별도로 보관하거나 소비하는 제품은 포함합니다.
5. 상품별 실제 구매 수량과 단위를 구분합니다.
6. 묶음 상품은 가능한 경우 구성 수량을 반영합니다.
7. 구매일은 영수증에 인쇄된 날짜를 사용합니다.
8. 상품별 카테고리를 다음 중 하나로 분류합니다.
   채소, 과일, 육류, 유제품, 기타
9. 보관 위치를 다음 중 하나로 추천합니다.
   냉장, 냉동, 실온, 김치냉장고
10. 상품 특성과 일반적인 식품 보관 기준을 고려해
    예상 소비기한을 최대한 제안합니다.
11. 소비기한은 실제 제품 포장에 표시된 날짜가 아니라
    일반적인 보관 기준을 바탕으로 한 추정값입니다.
12. 추정이 매우 어려운 경우에만 소비기한을 빈 문자열로 반환합니다.
13. 수량은 숫자로, 단위는 문자열로 반환합니다.
14. 날짜 형식은 반드시 YYYY-MM-DD로 반환합니다.
15. 영수증에 없는 상품이나 정보를 만들어내지 마세요.
16. 식재료나 보관식품이 없다면 items를 빈 배열로 반환합니다.
17. 상품별 결제 금액(원, 할인 반영 후)을 price에 숫자로 넣습니다. 알 수 없으면 0입니다.

[반환 형식]

반드시 아래 JSON 형식으로만 답변하세요.
마크다운이나 별도 설명은 출력하지 마세요.

{
  "purchaseDate": "YYYY-MM-DD",
  "items": [
    {
      "name": "상품명",
      "category": "채소",
      "location": "냉장",
      "qty": 1,
      "unit": "개",
      "expiry": "YYYY-MM-DD",
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
          { text: prompt },
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
): Promise<string> {
  const apiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
      console.error(`[${model}] 시간 초과 (${REQUEST_TIMEOUT_MS}ms)`);
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
      "영수증 항목이 너무 많아 분석이 중간에 끊겼습니다. 영수증을 나눠서 찍어 주세요.",
      502,
      true,
    );
  }

  if (!outputText) {
    console.error(
      `[${model}] 빈 응답, finishReason=${candidate?.finishReason}`,
    );
    throw new AttemptError(
      "AI 분석 결과가 비어 있습니다. 영수증 사진을 다시 촬영해 주세요.",
      502,
      true,
    );
  }

  return outputText;
}

const allowedCategories = ["채소", "과일", "육류", "유제품", "기타"];
const allowedLocations = ["냉장", "냉동", "실온", "김치냉장고"];

function normalize(parsed: any) {
  const items = parsed.items
    .filter((item: any) => typeof item?.name === "string" && item.name.trim())
    .map((item: any) => ({
      name: item.name.trim().slice(0, 100),
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
      expiry: /^\d{4}-\d{2}-\d{2}$/.test(item.expiry || "") ? item.expiry : "",
      emoji: typeof item.emoji === "string" && item.emoji
        ? item.emoji.slice(0, 8)
        : "🥬",
      price: Number.isFinite(Number(item.price)) && Number(item.price) > 0
        ? Math.round(Number(item.price))
        : 0,
    }));

  const todayKorea = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const purchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.purchaseDate || "")
    ? parsed.purchaseDate
    : todayKorea;

  return { purchaseDate, items };
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
          throw new HttpError("영수증 이미지 형식이 올바르지 않습니다.", 400);
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
        const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL])];
        let lastError: HttpError | null = null;

        for (const model of models) {
          try {
            const outputText = await callGemini(
              model,
              apiKey,
              mimeType,
              base64Data,
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
              console.warn(`[${model}] 실패, 다음 모델로 넘어갑니다.`);
              continue;
            }
            throw error;
          }
        }

        throw lastError ||
          new HttpError("영수증 분석에 실패했습니다. 다시 시도해 주세요.", 502);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error
          ? error.message
          : "영수증 분석 중 오류가 발생했습니다.";

        console.error(`Receipt OCR error (${status}):`, message);
        return Response.json({ error: message }, { status });
      }
    },
  ),
};
