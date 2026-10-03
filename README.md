# 컬러링

iPad용 번호 컬러링북 웹앱. 빌드 과정 없이 정적 파일만으로 동작합니다.

## GitHub Pages에 올리기
1. 이 폴더 내용을 저장소 루트에 올립니다.
2. 저장소 **Settings → Pages → Build and deployment**에서 `Deploy from a branch`, 브랜치 `main` / 폴더 `/ (root)`를 선택합니다.
3. 몇 분 뒤 `https://<사용자>.github.io/<저장소>/`로 접속합니다.
4. iPad Safari에서 **공유 → 홈 화면에 추가**를 누르면 전체 화면 앱처럼 실행됩니다.

## 조작
| 동작 | 기능 |
|---|---|
| 애플펜슬 | 칠하기 (필압은 자동 보정) |
| 펜슬 호버 | 브러시 모양 커서 |
| 손가락 한 개로 문지르기 | 지우개 |
| 두 손가락 드래그 · 핀치 | 이동 · 확대 |
| 두 손가락 탭 | 되돌리기 |
| 세 손가락 탭 | 지우개 ↔ 브러시 전환 |

## AI 생성
새 도안 → 톱니바퀴에서 Google AI Studio API 키와 모델(기본 `gemini-3.1-flash-image`)을 넣습니다.
키는 이 기기의 브라우저에만 저장되고 저장소에는 올라가지 않습니다.

## 저장
진행 상황은 기기 안(IndexedDB)에 자동 저장됩니다. Safari 방문 기록·웹사이트 데이터를 지우면 함께 지워집니다.

## 구조
```
index.html
css/app.css
js/main.js      UI · 입력 · 제스처 · 저장
js/engine.js    브러시 엔진 · 되돌리기
js/design.js    번호 도안 생성 (기본 풍경 / 이미지 → 도안)
js/paper.js     도화지 질감
js/ai.js        Gemini 이미지 생성
js/storage.js   IndexedDB
```
