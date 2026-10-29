# LastFit 배포 안내

이 묶음은 별도 서버 코드가 필요 없는 정적 웹사이트입니다.

## 업로드

1. `lastfit-web.zip`을 압축 해제합니다.
2. `index.html`, `css/`, `js/`, `assets/`를 폴더 구조 그대로 정적 웹 호스팅에 업로드합니다. ZIP 업로드를 지원하는 호스팅에는 ZIP을 직접 업로드할 수 있습니다.
3. 공개 루트가 `index.html`이 있는 폴더를 가리키도록 설정합니다. 소스 저장소에서 배포한다면 게시 폴더는 `dist/web`입니다. 별도 웹 빌드나 서버 실행 명령은 필요하지 않습니다.
4. 배포 주소에서 Phase 1 → Phase 2 전환과 두 제품 선택, 좌우 전환, 사이즈 변경을 확인합니다.

로컬 파일을 더블 클릭하는 대신 HTTP 또는 HTTPS 주소로 실행하세요. three.js와 웹 폰트는 외부 CDN에서 불러오므로 인터넷 연결이 필요합니다.

## 포함된 제품

- Air Jordan 1 Dior — `assets/air-jordan-1-dior.glb`
- Air Jordan High — `assets/air-jordan-high.glb`

비활성화된 `running-sample.glb`와 `shoe-demo.glb`는 포함하지 않습니다. 원본 GLB는 그대로 포함하며, 최신 좌우 보정과 내부 바닥 높이·착화 변형 계산은 함께 제공하는 JavaScript에 적용되어 있습니다.

Dior의 국소 팽창·층 결합·추정 봉제 구속 근사도 포함합니다. 고정 기준 라스트와 표시용 안감 보정으로 열린 발목의 가상 벽과 잘못된 내부 패널을 정리했습니다. 기본 발262/94/54mm에서는 좌우 모두270mm가 추천됩니다. 이 내부 형상은 실측 대신 데모 기준으로 추정했으며, 현재 사용자 발이 커져도 함께 커지지 않습니다. 원본 GLB를 다시 만들 필요는 없습니다.

발바닥 안착은 고정 인솔에 대한 뒤꿈치·볼의 접촉과 제한된 발가락 굴곡을 반영합니다. 아치 아래의 공간은 유지하며, 체중에 따른 발바닥 압력은 계산하지 않습니다. 계산용 인솔 계층은 실행 중 추가되고 원본 GLB에는 저장되지 않습니다. 착화 시점 선택과 시간 이완 효과는 제거했습니다.

제품 사이즈 옆에 230~300mm 사이즈 추천을 제공합니다. 발 형상과 제품을 바꾸면 길이·볼·발등 및 국소 압박을 다시 확인하고, 통과한 치수만 ‘적용’할 수 있습니다. 조건을 만족하는 후보가 없으면 추천하지 않습니다.

## 파일 용량

두 모델은 합계65,883,628바이트(약62.8MiB)이며 GitHub Pages의 사이트1GB 한도 이내입니다. 가장 큰 GLB도 Git 저장소의 개별100MiB 제한 이내이므로 LFS 없이 배포할 수 있습니다. 브라우저 직접 업로드는25MiB 제한이 있으므로 Git으로 올리세요. 단일 HTML 대신 GLB를 분리한 `dist/web` 배포본을 사용합니다.

GitHub Pages용 독립 폴더는 `dist/github-pages`이고 ZIP은 `dist/lastfit-github-pages.zip`입니다. 이 폴더에는 `site/`의 두 모델과 필요한 웹 파일, 자동 배포 workflow만 포함됩니다. 비공개 작업 파일·발표 자료·실행 로그는 포함하지 않습니다. 저장소에 이 폴더 내용만 올리고 Settings → Pages → Source를 GitHub Actions로 설정합니다. GitHub CLI 로그인과 GitHub Pages를 사용할 수 있는 계정이 필요합니다. 최초 공개 배포에는 저장소를 생성하거나 업로드할 수 있는 권한이 필요합니다.

공식 제한: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits / https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github

Air Jordan High의 개별 파일 크기는 **55,083,996바이트(약 52.5MiB)**입니다. 호스팅의 개별 파일 업로드·제공 한도가 이 크기 이상이어야 합니다. ZIP 용량만 확인하지 말고 압축을 푼 GLB의 크기도 확인하세요. 제한이 더 작은 호스팅에서는 이 묶음을 그대로 배포할 수 없습니다.

업데이트할 때는 새 묶음의 파일을 모두 교체하고, 호스팅에서 기존 파일을 캐시한다면 캐시도 갱신하세요.

## 모델 출처

Air Jordan High: Ar41k, “Nike Air Jordan”, https://sketchfab.com/3d-models/nike-air-jordan-fd462c530d974f33a523d88a7562f1cf — CC BY 4.0, https://creativecommons.org/licenses/by/4.0/ . GLB 원본은 변경하지 않았으며 표시 좌표·스케일과 착화 시 변형은 실행 중 적용합니다.
