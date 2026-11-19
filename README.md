# 판단 게이트 (Decision Gate)

루미버스(Spindle) 비공개 확장. 마리나라의 로어북 "판단 활성화"를 재현합니다.
로어북 항목에 **판단 문장**을 달아 두면, 매 생성 직전에 Decision 모델이 그 문장이 지금 장면에 맞는지 판단해 항목을 켜거나(`trigger`) 끕니다(`require`).

- identifier `decision_gate_lv` · 권한 `generation`, `decisions` · 호스트 기능 `decisions-v1` 필요
- opt-in 항목이 하나도 없으면 아무것도 하지 않고 Decision 호출도 0회입니다.
- 판단할 항목은 한 번에 묶어 1회 호출(`noul` 질문). 같은 장면이면 캐시(최대 50개) 재사용.
- 판단 실패·시간 초과: `trigger`는 아무것도 안 함, `require`는 끔(`fail_open_require`로 변경 가능).
- 로그에는 항목 이름·점수·소요 시간만 남깁니다(대화 본문·판단 문장 금지).

## 항목에 판단 달기

항목 `extensions.decision_gate`에 아래 값을 씁니다(`decision_gate_lv`도 읽음).

```json
{ "mode": "trigger", "statement": "In the current scene, …", "threshold": 0.5 }
```

REST (본문은 `{ "value": … }`로 감싸야 하고, 네임스페이스는 `^_?[a-z][a-z0-9_]*$`):

```
PATCH /api/v1/world-books/:bookId/entries/:entryId/extensions/decision_gate
{ "value": { "mode": "trigger", "statement": "…", "threshold": 0.5 } }
```

제거: 같은 경로에 `{ "value": null }`.

## 설정 (확장 저장소 `settings.json`)

| 키 | 기본값 | 설명 |
|---|---|---|
| `enabled` | true | 전체 끄기 |
| `connection_id` | null | null이면 기본 Decision 연결 |
| `history_messages` | 6 | 판단에 보낼 최근 메시지 수(인사말 제외, 1~50) |
| `timeout_ms` | 6000 | 자체 제한. 500~9500로 보정(호스트 10초 제한 미만) |
| `fail_open_require` | false | require 항목 판단 실패 시 켤지 |
| `log_decisions` | true | 항목 이름·점수·시간만 로그 |

장면 문자열: `역할: 내용`, 메시지당 1,500자(뒤쪽 유지)·합계 8,000자, `wi-exclude` 속성이 붙은 태그 블록과 `<details>` 제거.

## 롤백

확장을 비활성화하면 인터셉터가 해제되어 원상 복귀합니다(항목의 `extensions.decision_gate` 값은 무시되며 남아도 무해).

## 개발

`bun test`, 빌드는 `bun build src/backend.ts --outfile dist/backend.js --target bun` (dist 커밋 포함).
