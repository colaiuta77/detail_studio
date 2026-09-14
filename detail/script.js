// 상세 탭의 안전한 렌더링과 기존 BookOasis 읽기·편집 API를 연결합니다.
(async function () {
  'use strict';
  const root = container.querySelector('.ds');
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  const all = (selector) => [...root.querySelectorAll(selector)];
  const meta = { ...(context.meta || {}) };
  const books = (context.books || []).filter((book) => Number.isInteger(Number(book.id)) && Number(book.id) > 0);
  let type, activeTab = 'overview', filesLoaded = false, similarLoaded = false, loadingSimilar = false;
  let extras = new Map(), canEdit = false, editScope = null, dirty = false, saving = false;
  const appearance = { banner: false, colorscape: false };
  try {
    const saved = JSON.parse(localStorage.getItem(`${pluginId}:appearance`));
    for (const key of Object.keys(appearance)) appearance[key] = saved?.[key] === true;
  } catch { /* 저장소가 제한된 브라우저에서는 현재 페이지에서만 설정한다. */ }
  let paletteSource = '', palette = null;
  let media = false, unit = '권', canDownload = false, libraryName = '', libraryId = null;
  const libraryTypes = { general: '일반도서', adult: '성인도서', audiobook: '오디오북', video: '영상강좌' };
  let fields = [['series_alias', '표시 제목'], ['author', '작가'], ['publisher', '출판사'], ['isbn', 'ISBN / WEB ID'], ['genre', '장르'], ['tags', '태그'], ['link', '관련 링크']];
  const title = (book) => book.title_alias || book.title || '제목 없음';
  const num = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const completed = (book) => Number(media ? (book.is_track_completed ?? book.is_episode_completed ?? book.is_completed) : book.is_completed) === 1;
  const progress = (book) => completed(book) ? 100 : media ? Math.min(100, num(book.track_progress_pct ?? book.episode_progress_pct)) : num(book.total_pages) ? Math.min(100, Math.round(num(book.pages_read) / num(book.total_pages) * 100)) : 0;
  const reading = (book) => !completed(book) && (media ? progress(book) > 0 : num(book.pages_read) > 0);
  const continueBook = () => (media && books.find((book) => Number(book.id) === Number(meta.current_track_id ?? meta.current_episode_id) && !completed(book))) || books.filter(reading).sort((a, b) => String(b.last_read_at || '').localeCompare(String(a.last_read_at || '')))[0] || books.find((book) => !completed(book)) || books[0];
  const split = (value) => [...new Set(String(value || '').split(/[,;|\n]/).map((part) => part.trim()).filter((part) => part && part !== '-'))];
  function formatDate(value) {
    if (!value) return '—';
    const text = String(value).trim();
    // SQL/ISO는 기록된 날짜를, Flask RFC 날짜는 UTC 날짜를 유지한다.
    if (/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(text)) return text.slice(0, 10);
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
  }
  function bytes(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const size = num(value);
    if (size < 1024) return `${size} B`;
    const unit = Math.min(3, Math.floor(Math.log(size) / Math.log(1024)));
    return `${(size / (1024 ** unit)).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
  }
  function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function icon(name) {
    const el = node('i', `fa-solid fa-${name}`);
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  function safeUrl(value, cover = false) {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (cover && !/^(https?:|\/)/i.test(raw)) raw = '/covers/' + raw.replace(/^covers\//, '');
    try {
      const url = new URL(raw, location.origin);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  function image(src, alt = '') {
    const wrapper = node('div', 'ds-book-art');
    const url = safeUrl(src, true);
    if (url) {
      const img = node('img');
      img.src = url;
      img.alt = alt;
      img.loading = 'lazy';
      img.addEventListener('error', () => { wrapper.replaceChildren(node('span', '', '표지 없음')); }, { once: true });
      wrapper.append(img);
    } else wrapper.append(node('span', '', '표지 없음'));
    return wrapper;
  }
  function coverColor(img) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    const drawing = canvas.getContext('2d', { willReadFrequently: true });
    if (!drawing) return null;
    drawing.drawImage(img, 0, 0, 24, 24);
    const pixels = drawing.getImageData(0, 0, 24, 24).data;
    const buckets = new Map();
    // ponytail: 24×24 색상 빈도 추정. 복잡한 팔레트가 필요하면 다중 색상 군집으로 확장한다.
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b, alpha] = pixels.slice(i, i + 4);
      const high = Math.max(r, g, b), low = Math.min(r, g, b);
      if (alpha < 128 || high < 25 || low > 235) continue;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0, weight: 0 };
      bucket.r += r; bucket.g += g; bucket.b += b; bucket.count++;
      bucket.weight += 1 + (high - low) / 255;
      buckets.set(key, bucket);
    }
    const dominant = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
    return dominant ? ['r', 'g', 'b'].map((key) => Math.round(dominant[key] / dominant.count)).join(', ') : null;
  }
  function applyColorscape() {
    root.dataset.colorscape = String(appearance.colorscape && !!palette);
    if (palette) root.style.setProperty('--ds-cover-rgb', palette);
    else root.style.removeProperty('--ds-cover-rgb');
  }
  function renderAppearance() {
    all('[data-effect]').forEach((el) => { el.checked = appearance[el.dataset.effect]; });
    const coverSrc = safeUrl(meta.cover_image || books[0]?.cover_image, true);
    const bannerSrc = safeUrl(meta.banner_image, true) || coverSrc;
    const banner = $('[data-banner]');
    root.dataset.bannerEnabled = String(appearance.banner && !!bannerSrc);
    banner.hidden = !appearance.banner || !bannerSrc;
    if (!banner.hidden && banner.src !== bannerSrc) {
      banner.onerror = () => {
        if (coverSrc && banner.src !== coverSrc) banner.src = coverSrc;
        else { banner.hidden = true; root.dataset.bannerEnabled = 'false'; }
      };
      banner.src = bannerSrc;
    }
    if (coverSrc !== paletteSource) {
      paletteSource = coverSrc;
      palette = null;
      root.dataset.colorStatus = 'idle';
    }
    applyColorscape();
    if (!appearance.colorscape || palette || root.dataset.colorStatus === 'loading' || root.dataset.colorStatus === 'unavailable') return;
    if (!coverSrc) { root.dataset.colorStatus = 'unavailable'; return; }
    root.dataset.colorStatus = 'loading';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const finish = (color) => {
      if (!root.isConnected || paletteSource !== coverSrc) return;
      palette = color;
      root.dataset.colorStatus = color ? 'ready' : 'unavailable';
      applyColorscape();
    };
    img.onload = () => {
      try { finish(coverColor(img)); } catch { finish(null); }
    };
    img.onerror = () => finish(null);
    img.src = coverSrc;
  }
  function renderChips() {
    $('[data-chips]').replaceChildren();
    if (String(meta.books_lv || '').trim()) {
      const raw = String(meta.books_lv).trim().toLowerCase();
      const level = Number(meta.content_rating_level ?? (['everyone', '일반'].includes(raw) ? 0 : ['ma15+', 'm', '15세'].includes(raw) ? 15 : 18));
      const badge = node('span', 'ds-chip ds-rating');
      badge.dataset.level = String(level);
      badge.title = `도서 등급: ${meta.books_lv}`;
      const shield = node('i', 'fa-solid fa-shield-halved');
      shield.setAttribute('aria-hidden', 'true');
      badge.append(shield, document.createTextNode(meta.content_rating_label || (level === 0 ? '전체이용가' : level === 15 ? '15세이상' : '18세이상(성인)')));
      $('[data-chips]').append(badge);
    }
    for (const [kind, values] of [['genre', split(meta.genre)], ['tag', split(meta.tags)]]) {
      for (const value of values) {
        const chip = node('button', `ds-chip ds-chip-${kind}`, value);
        chip.type = 'button'; chip.dataset.filterKind = kind;
        chip.setAttribute('aria-label', `${kind === 'genre' ? '장르' : '태그'} ${value} 필터`);
        chip.addEventListener('click', async () => {
          const filter = kind === 'genre' ? window.quickFilterByGenre : window.quickFilterByTag;
          if (typeof filter !== 'function') return notify('필터 화면 연결을 사용할 수 없습니다. BookOasis를 새로고침해 주세요.', true);
          if (!allowNavigation()) return;
          try { await filter(value); } catch { notify('필터 화면을 열지 못했습니다. 다시 시도해 주세요.', true); }
        });
        $('[data-chips]').append(chip);
      }
    }
  }
  function notify(message, error = false) {
    const el = $('[data-notice]');
    el.textContent = message;
    el.dataset.error = String(error);
    el.hidden = false;
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(20000), ...options });
    let data;
    try { data = await response.json(); } catch { throw new Error('서버 응답을 읽지 못했습니다. 로그인 상태를 확인해 주세요.'); }
    if (!response.ok || !data.success) throw new Error(data.error || data.message || `요청 실패 (${response.status})`);
    return data;
  }
  function apiUrl(mode) {
    return `/api/media/dashboard/widgets/${encodeURIComponent(pluginId)}/data?` + new URLSearchParams({ type, book_id: media ? meta.id : books[0].id, mode, limit: 18 });
  }
  function allowNavigation() {
    if (saving) return false;
    if (dirty && !window.confirm('저장하지 않은 변경사항을 두고 이동할까요?')) return false;
    dirty = false;
    return true;
  }
  function read(book, resume = false) {
    if (!book) return;
    if (media) {
      const player = type === 'audiobook' ? window.openAudioPlayer : window.openVideoPlayer;
      const parentId = Number(meta.id);
      if (!Number.isInteger(parentId) || parentId < 1 || typeof player !== 'function') return notify('미디어 플레이어를 연결하지 못했습니다. 페이지를 새로고침해 주세요.', true);
      if (!allowNavigation()) return;
      const current = Number(meta.current_track_id ?? meta.current_episode_id) === Number(book.id);
      player(parentId, Number(book.id), resume && current && !completed(book) ? num(meta.current_time) : 0);
      return;
    }
    if (typeof window.openReader !== 'function') return notify('리더를 연결하지 못했습니다. 페이지를 새로고침해 주세요.', true);
    if (!allowNavigation()) return;
    window.openReader(Number(book.id), book.file_format, title(book), num(book.pages_read), num(book.total_pages));
  }
  function bindBookMenu(target, book) {
    if (media || !book) return;
    target.title = `${title(book)} · 우클릭으로 도서 메뉴`;
    target.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (dirty || saving) return notify('편집을 저장하거나 취소한 후 도서 메뉴를 열어 주세요.');
      if (typeof window.showBookContextMenu !== 'function') return notify('코어 도서 메뉴를 연결하지 못했습니다. 페이지를 새로고침해 주세요.', true);
      window.showBookContextMenu(event.clientX, event.clientY, Number(book.id), title(book), true, {
        seriesName: meta.series_name || context.seriesName,
        libraryId: book.library_id ?? libraryId ?? context.libraryId,
        markUnreadScope: 'book',
      });
      notify('메뉴에서 표지·메타정보·읽기 상태를 변경했다면 상세페이지를 다시 열어 최신 정보를 확인해 주세요.');
    });
  }
  function bookCard(book, index, recommended = false) {
    const card = node('article', 'ds-book');
    const button = node('button', 'ds-book-open');
    button.type = 'button';
    const label = recommended ? book.series_name : title(book);
    button.setAttribute('aria-label', `${label} ${recommended ? '상세 보기' : media ? '재생' : '읽기'}`);
    const art = image(recommended ? book.cover : book.cover_image);
    if (!recommended) {
      button.classList.add('ds-readable');
      bindBookMenu(art, book);
      art.append(node('span', 'ds-book-number', String(index + 1).padStart(2, '0')));
      const overlay = node('span', 'ds-book-overlay');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.append(node('i', `fa-solid ${media ? 'fa-play' : 'fa-book-open'}`));
      art.append(overlay);
    }
    button.append(art, node('span', 'ds-book-title', label));
    if (recommended) {
      button.append(node('span', 'ds-book-subtitle', book.author || '작가 미상'));
      button.addEventListener('click', () => {
        if (!allowNavigation()) return;
        if (typeof window.openBookDetail === 'function') window.openBookDetail(null, book.series_name, book.library_id, book.book_id);
        else notify('상세페이지 연결을 사용할 수 없습니다.', true);
      });
    } else {
      const state = completed(book) ? (media ? '재생 완료' : '완독') : reading(book) ? `${progress(book)}% ${media ? '재생' : '읽음'}` : (media ? '미재생' : '미독');
      button.append(node('span', 'ds-book-subtitle', `${String(book.file_format || '').toUpperCase()} · ${state}${media ? ` · ${book.time_str || '시간 미확인'}` : ''}`));
      const bar = node('progress');
      bar.max = 100;
      bar.value = progress(book);
      bar.setAttribute('aria-label', `${label} 진행률`);
      button.append(bar);
      button.addEventListener('click', () => read(book));
    }
    card.append(button);
    if (recommended) {
      const reasons = node('div', 'ds-reasons');
      for (const reason of book.reasons || []) reasons.append(node('span', '', reason));
      card.append(reasons);
    }
    return card;
  }
  function facts(target, entries) {
    target.replaceChildren();
    for (const [label, value] of entries) {
      const row = node('div');
      row.append(node('dt', '', label), node('dd', '', value || '—'));
      target.append(row);
    }
  }
  function metadataView() {
    facts($('[data-metadata]'), [['시리즈명', meta.series_name || context.seriesName], ...fields.map(([key, label]) => [label, meta[key]]), ['책 소개', meta.summary], ['메타정보 잠금', Number(meta.metadata_locked) === 1 ? '잠김' : '잠금 해제']]);
    const link = safeUrl(meta.link);
    const linkIndex = fields.findIndex(([key]) => key === 'link');
    if (link && linkIndex >= 0) {
      const dd = $('[data-metadata]').children[linkIndex + 1].querySelector('dd');
      const anchor = node('a', '', meta.link);
      anchor.href = link;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      dd.replaceChildren(anchor);
    }
  }
  function renderHeader() {
    const path = $('[data-library-path]');
    path.replaceChildren(node('span', '', 'LIBRARY'));
    for (const [label, id] of [[libraryTypes[type], 'home'], [libraryName, libraryId]]) {
      if (!label) continue;
      path.append(node('span', '', ' > '));
      const link = node('button', 'ds-library-link', label);
      link.type = 'button'; link.title = `${label} 홈으로 이동`;
      link.disabled = id == null;
      link.addEventListener('click', () => {
        if (typeof window.selectCategory !== 'function') return notify('서재 이동 기능을 연결하지 못했습니다. 새로고침해 주세요.', true);
        if (allowNavigation()) window.selectCategory(String(id));
      });
      path.append(link);
    }
    $('[data-title]').textContent = meta.series_alias || meta.series_name || context.seriesName || '도서 상세';
    const byline = $('[data-byline]');
    byline.replaceChildren();
    for (const [field, symbol] of [['author', 'pen-nib'], ['publisher', 'building']]) {
      const value = String(meta[field] || '').trim();
      if (!value || value === '-') {
        if (field === 'author') byline.append(node('span', '', '작가 미상'));
        continue;
      }
      if (byline.childNodes.length) byline.append(document.createTextNode(' · '));
      const button = node('button', 'ds-byline-button');
      button.type = 'button'; button.dataset.bylineField = field;
      button.title = field === 'author' ? `${value} 작가 검색` : '출판사 필터 안내';
      button.append(icon(symbol), document.createTextNode(value));
      button.addEventListener('click', async () => {
        if (field === 'publisher') return notify('출판사 필터는 현재 코어에서 지원하지 않습니다. 지원되면 연결할 예정입니다.');
        if (typeof window.selectCategory !== 'function') return notify('작가 검색을 연결하지 못했습니다. 새로고침해 주세요.', true);
        try {
          const { state } = await import('/static/js/state.js');
          if (!root.isConnected || !allowNavigation()) return;
          state.searchQuery = `작가:${value}`;
          const input = document.getElementById('library-search');
          if (input) input.value = state.searchQuery;
          window.selectCategory('all');
        } catch { notify('작가 검색을 열지 못했습니다.', true); }
      });
      byline.append(button);
    }
    if (byline.childNodes.length) byline.append(document.createTextNode(' · '));
    const count = node('span', 'ds-byline-count');
    count.append(icon('book-open'), document.createTextNode(`${books.length}${unit}`));
    byline.append(count);
    $('[data-action=collection]').disabled = !books.length;

    $('[data-format]').textContent = [...new Set(books.map((book) => String(book.file_format || '').toUpperCase()))].filter(Boolean).join(' / ') || '도서';
    renderChips();
    all('[data-count]').forEach((el) => { el.textContent = books.length; });
    const cover = $('[data-cover]');
    const src = safeUrl(meta.cover_image || books[0]?.cover_image, true);
    cover.hidden = !src;
    $('[data-no-cover]').hidden = !!src;
    if (src) cover.src = src;
    cover.alt = `${$('[data-title]').textContent} 표지`;
    cover.onerror = () => { cover.hidden = true; $('[data-no-cover]').hidden = false; };
    const total = books.reduce((sum, book) => sum + progress(book), 0);
    const percent = media ? (Number(meta.is_completed) === 1 ? 100 : Math.min(100, Math.round(num(meta.total_progress_pct)))) : books.length ? Math.round(total / books.length) : 0;
    const done = books.filter(completed).length;
    const inProgress = books.filter(reading).length;
    $('[data-percent]').textContent = `${percent}%`;
    $('[data-series-progress]').value = percent;
    $('[data-reading-state]').textContent = done === books.length && done ? (media ? '모두 재생했어요' : '모두 읽었어요') : inProgress || done ? (media ? '재생 중' : '읽는 중') : (media ? '재생 전' : '읽기 전');
    $('[data-reading-caption]').textContent = media ? `${books.length}${unit} 중 ${done}${unit} 완료 · 전체 재생 진행률` : `${books.length}권 중 ${done}권 완독 · 권별 진행률 평균`;
    const next = continueBook();
    $('[data-read-label]').textContent = media ? (next && reading(next) ? '이어 재생' : done && done === books.length ? '다시 재생' : '재생 시작') : next && reading(next) ? '이어 읽기' : done && done === books.length ? '다시 읽기' : '첫 미독 도서 읽기';
    $('[data-action=read]').disabled = !next;
    const favorite = $('[data-action=favorite]');
    favorite.disabled = !books.length;
    favorite.setAttribute('aria-pressed', String(books.length > 0 && books.every((book) => Number(book.is_favorite) === 1)));
    favorite.title = '시리즈 즐겨찾기';
    favorite.querySelector('i').className = favorite.getAttribute('aria-pressed') === 'true' ? 'fa-solid fa-star' : 'fa-regular fa-star';
    $('[data-summary]').textContent = meta.summary || '등록된 책 소개가 없습니다.';
    $('[data-summary]').classList.toggle('ds-clamped', String(meta.summary || '').length > 400);
    $('[data-action=summary]').hidden = String(meta.summary || '').length <= 400;
    $('[data-action=summary]').setAttribute('aria-expanded', 'false');
    $('[data-action=summary]').textContent = '더 보기';
    facts($('[data-facts]'), [['출판사', meta.publisher], ['ISBN / WEB ID', meta.isbn], ['소장 도서', `${books.length}${unit}`], ['파일 크기', filesLoaded ? bytes(books.reduce((sum, book) => sum + num(extras.get(Number(book.id))?.file_size ?? book.file_size), 0)) : '확인 중'], ['평점', num(meta.score ?? meta.ratings) ? String(meta.score ?? meta.ratings) : '—'], ...(media ? [['재생 시간', `${Math.floor(num(meta.total_duration) / 3600)}시간 ${Math.floor(num(meta.total_duration) % 3600 / 60)}분`]] : [])]);
    const last = books.map((book) => book.last_read_at || '').sort().at(-1);
    $('[data-stats]').replaceChildren(...[[media ? '재생 완료' : '완독', `${done}${unit}`], [media ? '재생 중' : '읽는 중', `${inProgress}${unit}`], [media ? '남은 항목' : '남은 도서', `${books.length - done}${unit}`]].map(([label, value]) => {
      const stat = node('div', 'ds-stat');
      stat.append(node('span', '', label), node('strong', '', value));
      return stat;
    }));
    const current = $('[data-current]');
    current.replaceChildren(node('small', '', last ? `${media ? '최근 재생' : '최근 읽은 날'} ${formatDate(last)}` : '다음 이야기'));
    if (next) {
      const link = node('button', 'ds-text-button', title(next));
      link.type = 'button';
      link.addEventListener('click', () => read(next, true));
      current.append(link);
    } else current.append(node('span', '', '등록된 도서가 없습니다.'));
    $('[data-preview-books]').replaceChildren(...books.slice(0, 6).map((book, index) => bookCard(book, index)));
    if (!books.length) $('[data-preview-books]').append(node('p', 'ds-empty', '이 시리즈에 표시할 도서가 없습니다.'));
    $('[data-series-description]').textContent = `총 ${books.length}${unit} · 표지를 눌러 바로 ${media ? '재생할' : '읽을'} 수 있어요.`;
    metadataView();
    renderAppearance();
  }
  function renderSeries() {
    const query = $('[data-series-search]').value.trim().toLocaleLowerCase();
    const filter = $('[data-series-filter]').value;
    const selected = books.filter((book) => title(book).toLocaleLowerCase().includes(query) && (filter === 'all' || (filter === 'completed' ? completed(book) : filter === 'reading' ? reading(book) : !completed(book) && !reading(book))));
    $('[data-series-books]').replaceChildren(...selected.map((book) => bookCard(book, books.indexOf(book))));
    if (!selected.length) $('[data-series-books]').append(node('p', 'ds-empty', '조건에 맞는 도서가 없습니다.'));
  }
  function renderFiles() {
    const query = $('[data-file-search]').value.trim().toLocaleLowerCase();
    const body = $('[data-files]');
    body.replaceChildren();
    const selected = books.filter((book) => `${title(book)} ${book.file_path || ''}`.toLocaleLowerCase().includes(query));
    $('[data-file-total]').textContent = `${books.length}개 파일`;
    for (const book of selected) {
      const extra = extras.get(Number(book.id)) || book;
      const row = node('tr');
      const name = node('td');
      const full = String(book.file_path || '');
      name.append(node('div', 'ds-file-name', full.split(/[\\/]/).at(-1) || title(book)));
      const path = node('details', 'ds-path');
      path.append(node('summary', '', full ? full.replace(/[\\/][^\\/]*$/, '') : '등록된 경로 없음'), node('code', '', full || '—'));
      name.append(path);
      const actions = node('div', 'ds-file-actions');
      const copy = node('button', 'ds-icon-button');
      copy.type = 'button';
      copy.title = '전체 경로 복사';
      copy.setAttribute('aria-label', `${title(book)} 경로 복사`);
      copy.disabled = !full;
      copy.append(icon('copy'));
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(full); notify('전체 파일 경로를 복사했습니다.'); }
        catch { path.open = true; notify('자동 복사가 제한되어 있습니다. 펼쳐진 전체 경로를 선택해 복사해 주세요.', true); }
      });
      actions.append(copy);
      const format = String(book.file_format).toLowerCase();
      if (!media && canDownload && ['epub', 'pdf', 'txt'].includes(format)) {
        const download = node('a', 'ds-icon-button');
        download.href = `/api/media/books/${Number(book.id)}/download?${new URLSearchParams({ type })}`;
        download.setAttribute('download', '');
        download.title = '다운로드';
        download.setAttribute('aria-label', `${title(book)} 다운로드`);
        download.append(icon('download'));
        actions.append(download);
      }
      const actionCell = node('td');
      actionCell.append(actions);
      row.append(name, node('td', '', String(book.file_format || '—').toUpperCase()), node('td', '', extra ? bytes(extra.file_size) : '—'), node('td', '', num(extra?.file_mtime) ? formatDate(new Date(extra.file_mtime * 1000)) : '—'), node('td', '', formatDate(extra?.created_at || book.created_at)), actionCell);
      body.append(row);
    }
    if (!selected.length) {
      const row = node('tr'), cell = node('td', '', '조건에 맞는 파일이 없습니다.');
      cell.colSpan = 6;
      row.append(cell); body.append(row);
    }
  }
  async function loadFiles() {
    if (!books.length) return;
    try {
      const data = await request(apiUrl('files'));
      if (!root.isConnected) return;
      extras = new Map((data.files || []).map((file) => [Number(file.id), file]));
      canEdit = type !== 'video' && data.can_edit === true;
      editScope = data.edit_scope;
      libraryName = data.library_name || '';
      libraryId = data.library_id ?? null;
      canDownload = data.can_download === true;
      if (media) $('#ds-panel-files .ds-hint').textContent = '경로는 서버 기준입니다. 책 등록일은 개별 파일의 등록일이며, 제공되지 않는 날짜는 —로 표시합니다.';
      filesLoaded = true;
      $('[data-action=edit]').hidden = !canEdit;
      $('[data-edit-caption]').textContent = canEdit ? '시리즈 정보를 확인하고 수정할 수 있어요.' : type === 'video' ? '비디오 메타정보는 읽기 전용입니다. 코어 상세 편집 API가 지원하지 않습니다.' : '시리즈에 등록된 정보입니다. 편집은 관리자만 할 수 있습니다.';
      renderFiles(); renderHeader();
    } catch (error) {
      if (root.isConnected) {
        notify(`추가 파일 정보와 편집 권한을 확인하지 못했습니다. ${error.message}`, true);
        $('[data-facts]').querySelectorAll('dd')[3].textContent = '확인 불가';
      }
    }
  }
  async function loadSimilar(force = false) {
    if ((!force && similarLoaded) || loadingSimilar) return;
    const target = $('[data-similar]');
    if (!books.length) { target.replaceChildren(node('p', 'ds-empty', '추천할 기준 도서가 없습니다.')); return; }
    loadingSimilar = true;
    target.setAttribute('aria-busy', 'true');
    target.replaceChildren(node('p', 'ds-empty', '함께 읽기 좋은 책을 찾고 있어요.'));
    try {
      const data = await request(apiUrl('similar'));
      if (!root.isConnected) return;
      target.replaceChildren(...(data.items || []).map((book, index) => bookCard(book, index, true)));
      if (!data.items?.length) target.append(node('p', 'ds-empty', '아직 비슷한 도서를 찾지 못했어요. 작가·장르·태그가 등록되면 추천이 더 정확해집니다.'));
      similarLoaded = true;
    } catch (error) { target.replaceChildren(node('p', 'ds-empty', `추천을 불러오지 못했습니다. ${error.message}`)); }
    finally { loadingSimilar = false; target.removeAttribute('aria-busy'); }
  }
  function selectTab(tab, focus = false) {
    activeTab = tab;
    all('[data-tab]').forEach((el) => {
      const selected = el.dataset.tab === tab;
      el.setAttribute('aria-selected', String(selected)); el.tabIndex = selected ? 0 : -1;
      if (selected && focus) el.focus();
    });
    all('[role=tabpanel]').forEach((el) => { el.hidden = el.id !== `ds-panel-${tab}`; });
    if (tab === 'similar') loadSimilar();
    if (tab === 'files' && !filesLoaded) loadFiles();
  }
  function editMode(on) {
    if (saving) return;
    $('[data-edit-form]').hidden = !on;
    $('[data-metadata-view]').hidden = on;
    $('[data-action=edit]').hidden = on || !canEdit;
    if (!on) { dirty = false; return; }
    const form = $('[data-edit-form]');
    form.reset();
    for (const [key] of fields) form.elements[key].value = meta[key] || '';
    form.elements.summary.value = meta.summary || '';
    $('[data-edit-scope]').textContent = `‘${meta.series_name || context.seriesName}’ 시리즈 전체 ${editScope?.books ?? books.length}권에 적용됩니다.${num(editScope?.libraries) > 1 ? ` 같은 이름의 시리즈가 있는 ${editScope.libraries}개 서재가 함께 수정됩니다.` : ''}`;
    if (type === 'audiobook') $('[data-edit-scope]').textContent = `같은 제목 또는 폴더명의 오디오북 ${editScope?.books ?? 1}개, ${editScope?.libraries ?? 1}개 서재에 적용됩니다.`;
    form.elements[fields[0][0]].focus();
  }
  async function save(event) {
    event.preventDefault();
    if (!canEdit || saving) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!media) data.set('books_lv', meta.books_lv || '');
    const file = data.get('cover_image');
    if (file?.size && (file.size > 10 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) return notify('표지는 10MB 이하의 JPG, PNG, WebP 파일을 선택해 주세요.', true);
    if (!file?.size) data.delete('cover_image');
    const link = String(data.get('link') || '').trim();
    if (link && !/^https?:\/\//i.test(link)) return notify('관련 링크는 http:// 또는 https:// 주소로 입력해 주세요.', true);
    data.set('type', type); data.set('series', meta.series_name || context.seriesName);
    saving = true;
    all('[data-edit-form] button, [data-edit-form] input, [data-edit-form] textarea').forEach((el) => { el.disabled = true; });
    try {
      await request('/api/media/detail/edit', { method: 'POST', body: data });
      if (!root.isConnected) return;
      for (const [key] of fields) meta[key] = String(data.get(key) || '');
      meta.summary = String(data.get('summary') || ''); meta.metadata_locked = type === 'audiobook' ? 0 : 1;
      dirty = false; similarLoaded = false;
      // 저장 성공과 이후 새로고침 실패를 구분해 중복 저장을 피한다.
      let refreshed = true;
      try {
        const result = await request('/api/media/detail?' + new URLSearchParams({ type, series: context.seriesName, library_id: context.libraryId || 'all', representative_book_id: media ? meta.id : books[0]?.id || '' }));
        if (result.meta) Object.assign(meta, result.meta);
      } catch { refreshed = false; }
      saving = false;
      editMode(false); renderHeader();
      notify(refreshed ? '시리즈 메타정보를 저장했습니다.' : '저장은 완료했습니다. 최신 표지는 페이지를 다시 열면 확인할 수 있습니다.');
    } catch (error) { if (root.isConnected) notify(`저장하지 못했습니다. 입력 내용은 유지됩니다. ${error.message}`, true); }
    finally {
      saving = false;
      all('[data-edit-form] button, [data-edit-form] input, [data-edit-form] textarea').forEach((el) => { el.disabled = false; });
    }
  }
  try {
    const { state } = await import('/static/js/state.js');
    if (!root.isConnected) return;
    type = state.currentLibraryType;
    if (!['general', 'adult', 'audiobook', 'video'].includes(type)) throw new Error('지원하지 않는 서재 유형입니다.');
    media = type === 'audiobook' || type === 'video';
    unit = type === 'audiobook' ? '트랙' : type === 'video' ? '편' : '권';
    if (media) {
      meta.isbn = meta.web_id || '';
      $('[data-action=read] i').className = `fa-solid ${type === 'audiobook' ? 'fa-headphones' : 'fa-play'}`;
      $('.ds-rail').setAttribute('aria-label', '표지 및 재생');
      $('[data-series-progress]').setAttribute('aria-label', '전체 재생 진행률');
      $('.ds-rail-note .ds-eyebrow').textContent = type === 'audiobook' ? 'MY LISTENING' : 'MY WATCHING';
      $('.ds-reading-card .ds-section-label').textContent = type === 'audiobook' ? '나의 청취' : '나의 시청';
      $('#ds-panel-overview .ds-section-heading p').textContent = '이어지는 트랙과 에피소드.';
      $('#ds-panel-series h2').textContent = type === 'audiobook' ? '트랙 목록' : '에피소드 목록';
      $('[data-series-search]').placeholder = '제목 검색';
      $('[data-series-search]').setAttribute('aria-label', '제목 검색');
      $('[data-series-filter]').setAttribute('aria-label', '재생 상태 필터');
      all('[data-series-filter] option').forEach((el, i) => { el.textContent = ['전체', '재생 중', '미재생', '재생 완료'][i]; });
      $('[data-tab=similar]').textContent = '유사한 콘텐츠';
      $('#ds-panel-similar h2').textContent = type === 'audiobook' ? '함께 듣기 좋은 오디오북' : '함께 보기 좋은 비디오';
      $('#ds-panel-similar .ds-section-heading p').textContent = type === 'audiobook' ? '같은 작가의 오디오북을 골랐어요.' : '공통 장르의 비디오를 골랐어요.';
    }
    if (type === 'audiobook') {
      fields = [['author', '작가'], ['isbn', 'WEB ID'], ['publisher', '출판사']];
      $('.ds-savebar > span').textContent = '오디오북의 작가·WEB ID·출판사·소개·표지를 저장합니다.';
    }
    all('[data-effect]').forEach((input) => input.addEventListener('change', () => {
      appearance[input.dataset.effect] = input.checked;
      try { localStorage.setItem(`${pluginId}:appearance`, JSON.stringify(appearance)); } catch { /* 현재 페이지의 선택은 유지한다. */ }
      renderAppearance();
    }));
    for (const [key, label] of fields) {
      const field = node('label', 'ds-field', label), input = node('input');
      input.name = key; input.type = key === 'link' ? 'url' : 'text'; input.maxLength = key === 'link' ? 2000 : 4000;
      field.append(input); $('[data-edit-fields]').append(field);
    }
    all('[data-tab]').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
    $('.ds-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = all('[data-tab]'), current = tabs.findIndex((el) => el.dataset.tab === activeTab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.tab, true);
    });
    $('[data-action=read]').addEventListener('click', () => read(continueBook(), true));
    $('[data-action=collection]').addEventListener('click', async (event) => {
      if (saving || !books.length) return;
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const { openAddToCollectionModal } = await import('/static/js/tab_collections.js');
        if (!root.isConnected) return;
        const item = { title: meta.series_alias || meta.series_name || context.seriesName };
        if (media) {
          const id = Number(meta.id);
          if (!Number.isInteger(id) || id < 1) throw new Error('미디어 ID 없음');
          item[type === 'audiobook' ? 'audiobook_id' : 'video_id'] = id;
        } else item.series_name = meta.series_name || context.seriesName;
        openAddToCollectionModal(item);
      } catch { notify('컬렉션 선택 창을 열지 못했습니다. 새로고침 후 다시 시도해 주세요.', true); }
      finally { button.disabled = !books.length; }
    });
    $('[data-action=show-files]').addEventListener('click', () => selectTab('files', true));
    $('[data-action=show-series]').addEventListener('click', () => selectTab('series', true));
    $('[data-action=summary]').addEventListener('click', (event) => {
      const expanded = event.currentTarget.getAttribute('aria-expanded') !== 'true';
      event.currentTarget.setAttribute('aria-expanded', String(expanded)); event.currentTarget.textContent = expanded ? '접기' : '더 보기';
      $('[data-summary]').classList.toggle('ds-clamped', !expanded);
    });
    $('[data-action=favorite]').addEventListener('click', async (event) => {
      const button = event.currentTarget, selected = button.getAttribute('aria-pressed') !== 'true';
      button.disabled = true;
      const data = new FormData();
      data.set('type', type); data.set('series_name', meta.series_name || context.seriesName); data.set('is_favorite', selected ? '1' : '0');
      try {
        await request('/api/media/series/favorite', { method: 'POST', body: data });
        if (!root.isConnected) return;
        books.forEach((book) => { book.is_favorite = selected ? 1 : 0; });
        button.setAttribute('aria-pressed', String(selected));
        button.querySelector('i').className = selected ? 'fa-solid fa-star' : 'fa-regular fa-star';
        notify(selected ? '시리즈를 즐겨찾기에 추가했습니다.' : '시리즈 즐겨찾기를 해제했습니다.');
      } catch (error) { notify(error.message, true); }
      finally { button.disabled = false; }
    });
    all('[data-view]').forEach((button) => button.addEventListener('click', () => {
      all('[data-view]').forEach((el) => el.setAttribute('aria-pressed', String(el === button)));
      $('[data-series-books]').classList.toggle('ds-list', button.dataset.view === 'list');
    }));
    $('[data-series-search]').addEventListener('input', renderSeries);
    $('[data-series-filter]').addEventListener('change', renderSeries);
    $('[data-file-search]').addEventListener('input', renderFiles);
    $('[data-action=retry-similar]').addEventListener('click', () => loadSimilar(true));
    $('[data-action=edit]').addEventListener('click', () => { if (canEdit) editMode(true); });
    $('[data-action=cancel-edit]').addEventListener('click', () => { if (!dirty || window.confirm('저장하지 않은 변경사항을 버릴까요?')) editMode(false); });
    $('[data-edit-form]').addEventListener('input', () => { dirty = true; });
    $('[data-edit-form]').addEventListener('submit', save);
    // 코어 SPA 이동과 브라우저 종료 양쪽에서 편집 내용을 보호한다.
    const stopNavigation = (event) => {
      if (!root.isConnected) return;
      const el = event.target.closest('a, button, [data-id], .menu-item, .book-card');
      if (!el || !(dirty || saving) || root.contains(el)) return;
      if (!allowNavigation()) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const beforeUnload = (event) => { if (root.isConnected && (dirty || saving)) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('click', stopNavigation, true);
    window.addEventListener('beforeunload', beforeUnload);
    const observer = new MutationObserver(() => {
      if (root.isConnected) return;
      document.removeEventListener('click', stopNavigation, true); window.removeEventListener('beforeunload', beforeUnload); observer.disconnect();
    });
    observer.observe(container.parentNode || document.body, { childList: true, subtree: true });
    bindBookMenu($('.ds-cover'), books[0]);
    renderHeader(); renderSeries(); renderFiles();
    root.dataset.ready = 'true';
    await loadFiles();
  } catch (error) { notify(`상세 화면을 불러오지 못했습니다. ${error.message}`, true); }
})();
