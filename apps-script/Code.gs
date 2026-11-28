/**
 * 세나컴퍼니 홈페이지 ↔ 노션 연결 스크립트
 *
 * 하는 일
 *  1) 공구 신청 → 노션 '셀러 DB'에 자동 등록
 *     - 셀러 DB·제외 셀러 DB에 같은 계정이 있는지 자동 확인해서 '중복 확인' 칸과 '메모'에 결과를 적음
 *     - 새 신청이 들어오면 알림 메일 발송 (받는 주소: 스크립트 속성 NOTIFY_EMAIL, 없으면 sena.beautylab@gmail.com)
 *  2) 홈페이지 품목 목록 제공 (?action=catalog)
 *     - 노션 '🌐 홈페이지 품목' DB에서 '홈페이지 노출'이 체크된 품목만, '순서' 순으로
 *     - 제품 사진·상세 이미지는 '공식몰 페이지'에서 자동으로 가져옴 (공식몰 사진이 바뀌면 자동 반영, 최대 1시간)
 *     - 공구가·공급가는 절대 내보내지 않음 (DB에 칸 자체가 없음)
 *
 * 처음 한 번만 할 설정 (자세한 순서는 노션 '사용법 (직원용)' 페이지 참고)
 *  1) 프로젝트 설정 > 스크립트 속성에 NOTION_TOKEN 추가 (노션 내부 통합 시크릿)
 *     (선택) NOTIFY_EMAIL: 알림 받을 메일 주소. 여러 개면 쉼표로 구분
 *     (선택) SLACK_WEBHOOK_URL: 슬랙 알림을 받을 Incoming Webhook 주소. 넣은 뒤 testSlack 실행으로 확인
 *  2) 편집기 위쪽 함수 목록에서 setup 선택 → 실행 → 권한 허용 (메일 발송·1시간마다 사진 새로고침 등록)
 *  3) 배포 > 배포 관리 > 연필 > 버전: 새 버전 > 배포  (주소는 그대로 유지됨)
 */

const SELLER_DB = '41c17c1104fb81e1aa33dcfa76d6b083';   // 셀러 DB
const EXCLUDE_DB = '41e17c1104fb81a3aa25d2b7e54b83e8';  // 제외 셀러 DB
const CATALOG_DB = '42017c1104fb8140a45bd77b281d78bb';  // 🌐 홈페이지 품목
const NOTION_VERSION = '2022-06-28';
const DEFAULT_NOTIFY = 'sena.beautylab@gmail.com';
const CATALOG_KEY = 'catalog_v2';

// 홈페이지 채널 이름 → 셀러 DB '채널' 선택지
const CHANNEL_MAP = {
  '인스타그램': '인스타', '틱톡': '틱톡', '유튜브': '유튜브', '그립': '그립',
  '클릭메이트': '클릭메이트', '블로그': '블로그', '기타': '기타'
};
const WHEN_OPTIONS = ['가능한 빨리', '2주 이내', '이번 달', '다음 달', '협의'];
const EXP_OPTIONS = ['많음(월 2회+)', '있음', '없음'];
// 품목 DB를 못 읽을 때만 쓰는 예비 목록
const FALLBACK_ITEMS = ['스윙키 보드','에어힙','홀딩미','더툴300','허리안 프로','릴로아','한방 파라핀베스','에어슈','단잠',
  '펄스코어 EMS','온눅 매트','코코 지압 슬리퍼','셀룰업','코리아나 쿨링 밸런스 겔','누벨리아 넥크림','누벨리아 아이크림',
  '프로메종 무선 고데기','루미오닉','넥세라','넥 케어 세트','아이 케어 세트','엘루아','스칼토'];
const CAT_CODE = { '홈케어 디바이스': 'device', '뷰티': 'beauty', '다이어트·바디': 'diet' };

/* ───────────── 진입점 ───────────── */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'catalog') {
    let body;
    try { body = getCatalogJson_(p.refresh === '1'); }
    catch (err) { console.error(err); body = JSON.stringify({ ok: false, items: [] }); }
    return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
  }
  return handleApply_(p, false); // 예전 방식(주소로 전송)도 계속 받음
}

function doPost(e) {
  return handleApply_((e && e.parameter) || {}, true);
}

/* ───────────── 공구 신청 ───────────── */

function handleApply_(p, isPost) {
  if (p.src !== 'sena') return page_('잘못된 접근이에요', '세나컴퍼니 홈페이지에서 신청해 주세요.', false);
  if (p.hp) return page_('신청이 접수됐어요', '확인 후 1~2일 안에 연락드릴게요.', true); // 자동 입력 봇 차단용 숨은 칸

  const allowed = allowedItems_();
  const name = clip_(p.name, 100);
  const items = String(p.items || '').split('|').map(s => s.trim()).filter(s => allowed.indexOf(s) >= 0);
  if (!name || !items.length || !p.phone) {
    return page_('신청 내용이 비어 있어요', '홈페이지로 돌아가 활동명, 품목, 연락처를 확인해 주세요.', false);
  }
  if (isPost && p.agree !== 'y') {
    return page_('개인정보 수집·이용 동의가 필요해요', '홈페이지로 돌아가 동의 칸에 체크한 뒤 다시 신청해 주세요.', false);
  }

  // 같은 내용이 30분 안에 두 번 들어오면(새로고침·중복 클릭 등) 한 번만 등록
  const key = 'ap_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(p)));
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (cache.get(key)) return page_('이미 접수됐어요', '확인 후 1~2일 안에 연락드릴게요.', true);
    cache.put(key, '1', 1800); // 등록 전에 먼저 표시해서 동시에 들어온 같은 신청을 막음
  } finally {
    lock.releaseLock();
  }

  const channels = String(p.ch || '').split('|').filter(Boolean);
  const mainCh = CHANNEL_MAP[channels[0]] || '기타';
  const fee = parseFloat(p.fee);
  const fol = parseInt(String(p.fol || '').replace(/[^0-9]/g, ''), 10);
  const link = clip_(p.link, 300);

  let memo = clip_(p.memo, 1500);
  if (channels.length > 1) memo = '활동 채널: ' + channels.join(', ') + (memo ? '\n' + memo : '');

  // 중복·제외 셀러 자동 확인 (등록 전에 해야 자기 자신이 안 걸림)
  let dup;
  try { dup = dupCheck_(link); }
  catch (err) { console.error(err); dup = { status: '확인 요청', note: '[자동 확인 실패] 셀러 DB·제외 셀러 DB를 직접 확인해 주세요.' }; }

  const staffMemo = dup.note + (p.agree === 'y'
    ? '\n[개인정보 동의] ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' 홈페이지에서 동의' : '');

  const props = {
    '셀러명': { title: [{ text: { content: name } }] },
    '신청 계정': rt_(link),
    '채널': { select: { name: mainCh } },
    '신청 품목': { multi_select: items.map(n => ({ name: n })) },
    '연락처': rt_(clip_(p.phone, 100)),
    '신청 메모': rt_(memo),
    '메모': rt_(staffMemo),
    '중복 확인': { select: { name: dup.status } }
  };
  if (!isNaN(fol)) props['팔로워 수'] = { number: fol };
  if (!isNaN(fee)) props['희망 수수료(%)'] = { number: fee };
  if (WHEN_OPTIONS.indexOf(p.when) >= 0) props['희망 공구 시기'] = { select: { name: p.when } };
  if (EXP_OPTIONS.indexOf(p.exp) >= 0) props['공구 경험'] = { select: { name: p.exp } };
  if (p.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) props['이메일'] = { email: clip_(p.email, 200) };

  const res = notion_('post', '/v1/pages', { parent: { database_id: SELLER_DB }, properties: props });
  if (res.code !== 200) {
    console.error(res.text);
    cache.remove(key); // 실패했으면 다시 신청할 수 있게 표시를 지움
    return page_('접수 중 문제가 생겼어요', '잠시 후 다시 시도하시거나 인스타그램 @senacompany_sns 으로 DM 주세요.', false);
  }

  try { notify_(p, name, items, channels, dup, res.json.url); } catch (err) { console.error(err); }

  return page_('신청이 접수됐어요', name + '님, 신청 감사합니다. 확인 후 1~2일 안에 공구가와 자료를 보내드릴게요.', true);
}

// 인스타 아이디 뽑기: "@abc", "abc", "https://instagram.com/abc/?..." → "abc"
function handle_(link) {
  let s = String(link || '').trim().toLowerCase();
  const m = s.match(/instagram\.com\/([a-z0-9._]+)/);
  if (m) s = m[1];
  else if (/^https?:\/\//.test(s) || s.indexOf('/') >= 0) return '';
  s = s.replace(/^@/, '').replace(/[^a-z0-9._]/g, '');
  return s.length >= 3 ? s : '';
}

function dupCheck_(link) {
  const h = handle_(link);
  if (!h) return { status: '확인 요청', note: '[자동 확인] 인스타 아이디를 알 수 없는 계정이라 직접 확인이 필요해요.' };

  const ex = queryDb_(EXCLUDE_DB, { filter: { or: [
    { property: '계정', title: { equals: h } },
    { property: '인스타 링크', url: { contains: 'instagram.com/' + h } }
  ] }, page_size: 5 });
  if (ex.length) {
    const r = ex[0].properties;
    const why = [selName_(r['제외 사유']), selName_(r['진행 벤더'])].filter(Boolean).join(' / ');
    return { status: '기존 벤더 셀러(제외)', note: '⚠ [자동 확인] 제외 셀러 DB에 있는 계정(@' + h + ')' + (why ? ' — ' + why : '') + '. 연락 전 확인 필요.' };
  }

  const old = queryDb_(SELLER_DB, { filter: { or: [
    { property: '신청 계정', rich_text: { contains: h } },
    { property: '인스타 계정', url: { contains: 'instagram.com/' + h } }
  ] }, page_size: 5 });
  if (old.length) {
    const r = old[0].properties;
    const st = r['상태'] && r['상태'].status ? r['상태'].status.name : '';
    return { status: '확인 요청', note: '[자동 확인] 이미 셀러 DB에 있는 계정(@' + h + ')' + (st ? ', 기존 상태: ' + st : '') + ' — 재신청이에요. ' + old[0].url };
  }
  return { status: '신규 확인', note: '[자동 확인] 셀러 DB·제외 셀러 DB에 없는 새 계정(@' + h + '). 회사 인플루언서 DB는 직접 확인해 주세요.' };
}

function notify_(p, name, items, channels, dup, notionUrl) {
  const to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') || DEFAULT_NOTIFY;
  const flag = dup.status === '기존 벤더 셀러(제외)' ? '⚠제외셀러 ' : (dup.status === '확인 요청' ? '재신청 ' : '');
  const subject = '[세나컴퍼니] ' + flag + '새 공구 신청 - ' + name + ' (' + items.length + '개 품목)';
  const lines = [
    '홈페이지에서 새 공구 신청이 들어왔어요.', '',
    '활동명: ' + name,
    '계정: ' + (p.link || ''),
    '채널: ' + channels.join(', '),
    '팔로워: ' + (p.fol || ''),
    '희망 수수료: ' + (p.fee || '') + '%',
    '공구 경험: ' + (p.exp || '-'),
    '희망 시기: ' + (p.when || '-'),
    '연락처: ' + (p.phone || ''),
    '이메일: ' + (p.email || '-'), '',
    '신청 품목: ' + items.join(', '), '',
    '하고 싶은 말: ' + (p.memo || '-'), '',
    '중복 확인: ' + dup.status,
    dup.note, '',
    '노션에서 보기: ' + notionUrl
  ];
  MailApp.sendEmail({ to: to, subject: subject, body: lines.join('\n'), name: '세나컴퍼니 홈페이지' });
  try { slack_(flag, name, items, p, dup, notionUrl); } catch (err) { console.error('슬랙 알림 실패', err); }
}

// 슬랙 알림 (스크립트 속성 SLACK_WEBHOOK_URL 이 있을 때만). 연락처·이메일은 슬랙에 보내지 않음
function slack_(flag, name, items, p, dup, notionUrl) {
  const url = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!url) return;
  const icon = dup.status === '기존 벤더 셀러(제외)' ? ':warning:' : (dup.status === '확인 요청' ? ':mag:' : ':tada:');
  const text = icon + ' *' + flag + '새 공구 신청* - ' + name + '\n'
    + '• 품목: ' + items.join(', ') + '\n'
    + '• 수수료 ' + (p.fee || '-') + '% · 팔로워 ' + (p.fol || '-') + ' · 희망 시기 ' + (p.when || '-') + '\n'
    + '• 계정: ' + (p.link || '-') + '\n'
    + '• 중복 확인: ' + dup.status + '\n'
    + '<' + notionUrl + '|노션에서 보기>';
  UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ text: text }), muteHttpExceptions: true });
}

// 슬랙 연결 테스트: SLACK_WEBHOOK_URL 넣은 뒤 한 번 실행
function testSlack() {
  slack_('', '테스트(알림 확인용)', ['스윙키 보드'], { fee: '15', fol: '1000', when: '협의', link: '@test' },
    { status: '신규 확인' }, 'https://senacompany.co.kr');
  console.log('슬랙으로 테스트 메시지를 보냈어요. 안 오면 SLACK_WEBHOOK_URL 값을 확인하세요.');
}

/* ───────────── 홈페이지 품목 목록 ───────────── */

function getCatalogJson_(force) {
  const cache = CacheService.getScriptCache();
  if (!force) { const hit = cache.get(CATALOG_KEY); if (hit) return hit; }

  const rows = queryDb_(CATALOG_DB, {
    filter: { property: '홈페이지 노출', checkbox: { equals: true } },
    sorts: [{ property: '순서', direction: 'ascending' }],
    page_size: 100
  }, true);

  const items = rows.map(r => {
    const x = r.properties;
    const badges = (x['뱃지'] && x['뱃지'].multi_select || []).map(o => o.name);
    const it = {
      id: text_(x['품번']) || r.id.replace(/-/g, '').slice(0, 12),
      opt: text_(x['신청 품목명']) || text_(x['품목명']),
      brand: selName_(x['브랜드']) || '제스파',
      name: text_(x['품목명']),
      short: text_(x['짧은 이름']) || text_(x['품목명']),
      cats: (x['카테고리'] && x['카테고리'].multi_select || []).map(o => CAT_CODE[o.name]).filter(Boolean),
      price: x['소비자가'] && x['소비자가'].number || 0,
      desc: text_(x['한 줄 소개']),
      set: text_(x['구성']),
      note: text_(x['진행 안내']),
      best: badges.indexOf('BEST') >= 0,
      isNew: badges.indexOf('NEW') >= 0,
      pick: !!(x['MD PICK'] && x['MD PICK'].checkbox),
      why: text_(x['추천 이유']),
      url: x['공식 상세페이지'] && x['공식 상세페이지'].url || '',
      vid: x['제품 영상'] && x['제품 영상'].url || '',
      page: x['공식몰 페이지'] && x['공식몰 페이지'].url || ''
    };
    if (!it.cats.length) it.cats = ['device'];
    return it;
  }).filter(it => it.name && it.opt);

  const media = getMedia_(items.map(i => i.page).filter(Boolean), force);
  items.forEach(i => {
    const m = media[i.page];
    if (m) { i.img = m.img; i.gal = m.gal; i.det = m.det; }
    delete i.page;
  });

  const json = JSON.stringify({ ok: true, updated: new Date().toISOString(), items: items });
  if (json.length < 95000) cache.put(CATALOG_KEY, json, 3600);
  return json;
}

// 공식몰 페이지에서 사진 뽑기. 6시간 캐시, 실패하면 마지막으로 성공한 값 사용
function getMedia_(urls, force) {
  const cache = CacheService.getScriptCache();
  const store = PropertiesService.getScriptProperties();
  const out = {}, need = [];
  urls.forEach(u => {
    const k = 'm_' + hash_(u);
    const hit = !force && cache.get(k);
    if (hit) out[u] = JSON.parse(hit); else need.push(u);
  });
  if (need.length) {
    const reqs = need.map(u => ({ url: u, muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' } }));
    let resps = [];
    try { resps = UrlFetchApp.fetchAll(reqs); } catch (err) { console.error(err); }
    need.forEach((u, i) => {
      const k = 'm_' + hash_(u);
      let m = null;
      const r = resps[i];
      if (r && r.getResponseCode() === 200) {
        try { m = parseMall_(u, r.getContentText()); } catch (err) { console.error(u, err); }
      }
      if (m && m.img) {
        const s = JSON.stringify(m);
        cache.put(k, s, 21600);
        if (store.getProperty(k) !== s && s.length < 8500) store.setProperty(k, s);
        out[u] = m;
      } else {
        const last = store.getProperty(k);
        if (last) out[u] = JSON.parse(last);
      }
    });
  }
  return out;
}

function parseMall_(pageUrl, html) {
  const abs = s => {
    s = String(s).replace(/&amp;/g, '&').trim();
    if (s.indexOf('//') === 0) return 'https:' + s;
    if (s.indexOf('/') === 0) return pageUrl.match(/^https?:\/\/[^/]+/)[0] + s;
    return s.replace(/^http:\/\//, 'https://');
  };
  const uniq = a => a.filter((x, i) => x && a.indexOf(x) === i);
  const og = (html.match(/property="og:image"\s+content="([^"]+)"/) || html.match(/content="([^"]+)"\s+property="og:image"/) || [])[1];

  if (html.indexOf('id="prdDetail"') >= 0) { // 카페24 (zespamshop) — 주소가 아니라 내용으로 판단 (자사몰이 카페24로 넘겨주는 경우 대비)
    const gal = uniq((html.match(/\/\/[a-z0-9.]+\/web\/product\/(?:big|extra\/big)\/[^"'\s)]+\.(?:jpg|jpeg|png|gif|webp)/gi) || []).map(abs));
    let seg = html.slice(html.indexOf('id="prdDetail"'));
    const j = seg.search(/id="prd(Info|Review|QnA)"/); seg = j > 0 ? seg.slice(0, j) : seg.slice(0, 80000);
    const det = pickImgs_(seg, abs);
    const img = og ? abs(og) : gal[0];
    return { img: img, gal: uniq([img].concat(gal)).slice(0, 6), det: det };
  }

  // 고도몰: 제스파몰은 detail_explain, 로아벨몰은 id="detail" ~ id="delivery" 사이
  let seg = '';
  let i = html.indexOf('detail_explain');
  if (i > 0) { const j = html.indexOf('<!-- //', i); seg = html.slice(i, j > i ? j : i + 150000); }
  else if ((i = html.indexOf('id="detail"')) > 0) { const j = html.indexOf('id="delivery"', i); seg = html.slice(i, j > i ? j : i + 150000); }
  const det = pickImgs_(seg, abs);
  const img = og ? abs(og) : det[0];
  return { img: img, gal: img ? [img] : [], det: det };
}

function pickImgs_(seg, abs) {
  const out = [];
  (seg.match(/(?:ec-data-src|data-src|src)="([^"]+)"/gi) || []).forEach(s => {
    const u = s.replace(/^[^"]*"/, '').replace(/"$/, '');
    if (/^data:|echosting|skin_img|\{\$|\/product\/(tiny|small|medium|extra\/small)\/|\.svg|\.gif$|blank|spacer/i.test(u)) return;
    const a = abs(u);
    if (out.indexOf(a) < 0) out.push(a);
  });
  return out.slice(0, 80);
}

function allowedItems_() {
  try {
    const items = JSON.parse(getCatalogJson_(false)).items || [];
    if (items.length) return items.map(i => i.opt);
  } catch (err) { console.error(err); }
  return FALLBACK_ITEMS;
}

/* ───────────── 설정·자동 새로고침 ───────────── */

// 처음 한 번 실행: 권한 허용 + 1시간마다 품목·사진 새로고침 등록 + 테스트 메일
function setup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'refreshCatalog')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshCatalog').timeBased().everyHours(1).create();
  const json = refreshCatalog();
  const n = (JSON.parse(json).items || []).length;
  const to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') || DEFAULT_NOTIFY;
  MailApp.sendEmail(to, '[세나컴퍼니] 알림 연결 완료',
    '홈페이지 신청 알림이 이 주소로 오도록 연결됐어요.\n현재 홈페이지에 보이는 품목: ' + n + '개');
  console.log('완료: 품목 ' + n + '개, 알림 주소 ' + to);
}

// 1시간마다 자동 실행 (노션 품목 수정·공식몰 사진 변경 반영)
function refreshCatalog() { return getCatalogJson_(true); }

/* ───────────── 노션 도우미 ───────────── */

function notion_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const res = UrlFetchApp.fetch('https://api.notion.com' + path, {
    method: method, contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
    payload: body ? JSON.stringify(body) : undefined, muteHttpExceptions: true
  });
  const text = res.getContentText();
  let json = {};
  try { json = JSON.parse(text); } catch (e) {}
  return { code: res.getResponseCode(), json: json, text: text };
}

function queryDb_(dbId, body, all) {
  let out = [], cursor;
  do {
    const b = Object.assign({}, body);
    if (cursor) b.start_cursor = cursor;
    const r = notion_('post', '/v1/databases/' + dbId + '/query', b);
    if (r.code !== 200) throw new Error('노션 조회 실패 ' + r.code + ': ' + r.text.slice(0, 300));
    out = out.concat(r.json.results || []);
    cursor = all && r.json.has_more ? r.json.next_cursor : null;
  } while (cursor);
  return out;
}

function text_(prop) {
  if (!prop) return '';
  const arr = prop.title || prop.rich_text || [];
  return arr.map(t => t.plain_text).join('').trim();
}
function selName_(prop) { return prop && prop.select ? prop.select.name : ''; }
function hash_(s) { return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s)).slice(0, 22); }
function rt_(s) { return { rich_text: s ? [{ text: { content: s } }] : [] }; }
function clip_(s, n) { return String(s || '').trim().slice(0, n); }

function page_(title, msg, ok) {
  const html = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>세나컴퍼니</title>'
    + '<style>body{margin:0;font-family:Pretendard,system-ui,-apple-system,sans-serif;background:#FAF7EF;color:#303A36;display:flex;min-height:100vh;align-items:center;justify-content:center}'
    + '.c{background:#FFFDF8;border:1px solid #E7E1D3;border-radius:22px;padding:36px 30px;max-width:420px;margin:20px;text-align:center;box-shadow:0 12px 40px rgba(48,58,54,.08)}'
    + '.i{font-size:44px}h1{font-size:22px;color:#08745E;margin:12px 0 8px}p{color:#4E5853;line-height:1.6;margin:0;word-break:keep-all}'
    + 'a{display:inline-block;margin-top:20px;color:#08745E;font-weight:700;text-decoration:none}</style></head>'
    + '<body><div class="c"><div class="i">' + (ok ? '✅' : '⚠️') + '</div><h1>' + esc_(title) + '</h1><p>' + esc_(msg) + '</p>'
    + '<a href="https://senacompany.co.kr" target="_top">세나컴퍼니 홈으로</a>'
    + '<p style="margin-top:14px;font-size:13px">이 창은 닫으셔도 됩니다.</p></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('세나컴퍼니 공구 신청');
}
function esc_(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ───────────── 일회성: 상호 변경 (건강하세나 → 세나컴퍼니) ───────────── */

// 아직 보내지 않은(상태 '발굴') 셀러의 DM 초안에서 '건강하세나'를 '세나컴퍼니'로 바꿈.
// 편집기에서 renameBrandInDrafts 를 한 번 실행. 5분 안에 다 못 하면 다시 실행하면 남은 것만 처리됨.
function renameBrandInDrafts() {
  const rows = queryDb_(SELLER_DB, { filter: { and: [
    { property: '상태', status: { equals: '발굴' } },
    { property: 'DM 초안', rich_text: { contains: '건강하세나' } }
  ] }, page_size: 100 }, true);
  const start = Date.now();
  let done = 0, fail = 0;
  for (let k = 0; k < rows.length; k++) {
    if (Date.now() - start > 300000) break;
    const r = rows[k];
    const after = text_(r.properties['DM 초안']).split('건강하세나').join('세나컴퍼니');
    const chunks = [];
    for (let i = 0; i < after.length; i += 1900) chunks.push({ text: { content: after.slice(i, i + 1900) } });
    const res = notion_('patch', '/v1/pages/' + r.id, { properties: { 'DM 초안': { rich_text: chunks } } });
    if (res.code === 200) done++; else { fail++; console.error(res.text.slice(0, 300)); }
    Utilities.sleep(350);
  }
  console.log('대상 ' + rows.length + '명 중 ' + done + '명 변경, 실패 ' + fail + '명, 남은 ' + (rows.length - done - fail) + '명');
}
