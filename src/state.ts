// 판단 모델에 보낼 장면 문자열 (design §4-3).
export const MAX_PER_MESSAGE = 1500;
export const MAX_TOTAL = 8000;

export interface StateMessage {
  role: string;
  content: string;
  is_greeting?: boolean;
}

const WI_EXCLUDE_BLOCK = /<([A-Za-z][\w:-]*)\b[^>]*\swi-exclude(?=[\s=>/])[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DETAILS_BLOCK = /<details\b[^>]*>[\s\S]*?<\/details\s*>/gi;

/** wi-exclude 속성이 붙은 태그 블록과 <details> 접힘을 제거. */
export function stripExcluded(text: string): string {
  return text.replace(WI_EXCLUDE_BLOCK, '').replace(DETAILS_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 최근 n개(인사말 제외)를 `역할: 내용`으로. 메시지당·합계 상한, 넘치면 뒤쪽(최근)을 남긴다. */
export function buildState(messages: readonly StateMessage[], n: number): string {
  const picked = messages.filter((m) => !m.is_greeting).slice(-Math.max(1, n));
  const lines: string[] = [];
  let total = 0;
  for (let i = picked.length - 1; i >= 0; i--) {
    const m = picked[i]!;
    let body = stripExcluded(String(m.content ?? ''));
    if (!body) continue;
    if (body.length > MAX_PER_MESSAGE) body = body.slice(body.length - MAX_PER_MESSAGE);
    let line = `${m.role}: ${body}`;
    const remain = MAX_TOTAL - total;
    if (remain <= 0) break;
    if (line.length > remain) {
      if (remain < 200) break;
      line = line.slice(line.length - remain);
    }
    lines.unshift(line);
    total += line.length + 1; // 줄바꿈 포함
  }
  return lines.join('\n');
}
