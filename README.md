# AI2 Term Project — GitHub 게시용

이 폴더 안의 내용만 GitHub 저장소 루트에 올립니다. web은 학생 화면, .github/workflows/pages.yml은 자동 게시 설정입니다. GT, 계정, 제출 기록, Python 서버는 포함되어 있지 않습니다.

1. 이 폴더를 저장소 루트로 업로드합니다.
2. Settings → Pages → Source에서 GitHub Actions를 선택합니다.
3. web/config.js의 apiBase에 공개 HTTPS 채점 서버 주소를 설정합니다.
4. 서버 실행 시 Pages 주소의 origin을 허용합니다. 예: https://계정.github.io (저장소 경로 제외).

학교 IP 접속 시험 중에는 apiBase를 빈 문자열로 두고 학교 서버 주소로 직접 접속합니다. 이 상태로 GitHub Pages만 먼저 게시하면 채점 API가 연결되지 않습니다.
