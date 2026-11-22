/**
 * 세나컴퍼니 공구 신청 → 노션 셀러 DB 자동 등록
 *
 * 홈페이지의 '공구 신청하기' 버튼이 이 웹 앱 주소를 새 창으로 엽니다.
 * 이 스크립트가 신청 내용을 노션 '셀러 DB'에 한 줄로 등록하고 접수 완료 화면을 보여줍니다.
 *
 * 처음 한 번만 할 설정 (자세한 순서는 노션 '사용법 (직원용)' 페이지 참고)
 *  1) 프로젝트 설정 > 스크립트 속성에 NOTION_TOKEN 추가 (노션 내부 통합 시크릿)
 *  2) 배포 > 새 배포 > 웹 앱, 실행 사용자: 나, 액세스 권한: 모든 사용자
 *  3) 나온 웹 앱 URL(…/exec)을 Claude에게 전달
 */

const DATABASE_ID = '41c17c1104fb81e1aa33dcfa76d6b083'; // 노션 '셀러 DB'
const NOTION_VERSION = '2022-06-28';

// 홈페이지 채널 이름 → 셀러 DB '채널' 선택지
const CHANNEL_MAP = {
  '인스타그램': '인스타', '틱톡': '틱톡', '유튜브': '유튜브', '그립': '그립',
  '클릭메이트': '클릭메이트', '블로그': '블로그', '기타': '기타'
};
const WHEN_OPTIONS = ['가능한 빨리', '2주 이내', '이번 달', '다음 달', '협의'];
const EXP_OPTIONS = ['많음(월 2회+)', '있음', '없음'];
const ITEM_OPTIONS = ['스윙키 보드','에어힙','홀딩미','더툴300','허리안 프로','릴로아','한방 파라핀베스','에어슈','단잠',
  '펄스코어 EMS','온눅 매트','코코 지압 슬리퍼','셀룰업','코리아나 쿨링 밸런스 겔','누벨리아 넥크림','누벨리아 아이크림',
  '프로메종 무선 고데기','루미오닉','넥세라','넥 케어 세트','아이 케어 세트','엘루아','스칼토'];

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.src !== 'sena') return page_('잘못된 접근이에요', '세나컴퍼니 홈페이지에서 신청해 주세요.', false);

  const name = clip_(p.name, 100);
  const items = String(p.items || '').split('|').map(s => s.trim()).filter(s => ITEM_OPTIONS.indexOf(s) >= 0);
  if (!name || !items.length || !p.phone) {
    return page_('신청 내용이 비어 있어요', '홈페이지로 돌아가 활동명, 품목, 연락처를 확인해 주세요.', false);
  }

  // 같은 내용이 30분 안에 두 번 들어오면(새로고침·중복 클릭 등) 한 번만 등록
  const key = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(p)));
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

  let memo = clip_(p.memo, 1500);
  if (channels.length > 1) memo = '활동 채널: ' + channels.join(', ') + (memo ? '\n' + memo : '');

  const props = {
    '셀러명': { title: [{ text: { content: name } }] },
    '신청 계정': rt_(clip_(p.link, 300)),
    '채널': { select: { name: mainCh } },
    '신청 품목': { multi_select: items.map(n => ({ name: n })) },
    '연락처': rt_(clip_(p.phone, 100)),
    '신청 메모': rt_(memo),
    '중복 확인': { select: { name: '확인 요청' } }
  };
  if (!isNaN(fol)) props['팔로워 수'] = { number: fol };
  if (!isNaN(fee)) props['희망 수수료(%)'] = { number: fee };
  if (WHEN_OPTIONS.indexOf(p.when) >= 0) props['희망 공구 시기'] = { select: { name: p.when } };
  if (EXP_OPTIONS.indexOf(p.exp) >= 0) props['공구 경험'] = { select: { name: p.exp } };
  if (p.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) props['이메일'] = { email: clip_(p.email, 200) };

  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
    payload: JSON.stringify({ parent: { database_id: DATABASE_ID }, properties: props }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    console.error(res.getContentText());
    cache.remove(key); // 실패했으면 다시 신청할 수 있게 표시를 지움
    return page_('접수 중 문제가 생겼어요', '잠시 후 다시 시도하시거나 인스타그램 @sena.beautylab 으로 DM 주세요.', false);
  }
  return page_('신청이 접수됐어요', name + '님, 신청 감사합니다. 확인 후 1~2일 안에 공구가와 자료를 보내드릴게요.', true);
}

function rt_(s) { return { rich_text: s ? [{ text: { content: s } }] : [] }; }
function clip_(s, n) { return String(s || '').trim().slice(0, n); }

function page_(title, msg, ok) {
  const html = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>세나컴퍼니</title>'
    + '<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f3ec;color:#1f2a24;display:flex;min-height:100vh;align-items:center;justify-content:center}'
    + '.c{background:#fffdf9;border:1px solid #e4ddd0;border-radius:22px;padding:36px 30px;max-width:420px;margin:20px;text-align:center}'
    + '.i{font-size:44px}h1{font-size:22px;color:#2f4a3a;margin:12px 0 8px}p{color:#5d675f;line-height:1.6;margin:0}</style></head>'
    + '<body><div class="c"><div class="i">' + (ok ? '✅' : '⚠️') + '</div><h1>' + esc_(title) + '</h1><p>' + esc_(msg) + '</p>'
    + '<p style="margin-top:18px;font-size:13px">이 창은 닫으셔도 됩니다.</p></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('세나컴퍼니 공구 신청');
}
function esc_(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
