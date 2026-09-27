// 상세 탭의 안전한 렌더링과 기존 BookOasis 읽기·편집 API를 연결합니다.
(async function () {
  'use strict';
  const root = container.querySelector('.ds');
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  const all = (selector) => [...root.querySelectorAll(selector)];
  const meta = { ...(context.meta || {}) };
  const books = (context.books || []).filter((book) => Number.isInteger(Number(book.id)) && Number(book.id) > 0);
  let coreState;
  let type, activeTab = 'overview', filesLoaded = false, similarLoaded = false, loadingSimilar = false;
  let extras = new Map(), canEdit = false, editScope = null, dirty = false, saving = false;
  const appearance = { banner: false, colorscape: false, blur: false };
  try {
    const saved = JSON.parse(localStorage.getItem(`${pluginId}:appearance`));
    for (const key of Object.keys(appearance)) appearance[key] = saved?.[key] === true;
  } catch { /* 저장소가 제한된 브라우저에서는 현재 페이지에서만 설정한다. */ }
  let paletteSource = '', palette = null;
  let media = false, unit = '권', canDownload = false, libraryName = '', libraryId = null;
  const libraryTypes = { general: '일반도서', adult: '성인도서', audiobook: '오디오북', video: '영상강좌' };
  let fields = [['series_alias', '표시 제목'], ['author', '작가'], ['publisher', '출판사'], ['isbn', 'ISBN / WEB ID'], ['genre', '장르'], ['tags', '태그'], ['link', '관련 링크']];
  const extraFields = [['cover_artist', '그림 작가'], ['teams', '팀'], ['locations', '장소'], ['characters', '등장인물'], ['publication_status', '연재 상태'], ['publication_start_date', '연재 시작일'], ['publication_end_date', '연재 종료일'], ['release_date', '출간일'], ['manual_chapter_count', '회차 수']];
  let extendedReady = false, contentKind = '', contentKindName = '';
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
    const blur = $('[data-cover-blur]');
    root.dataset.coverBlur = String(appearance.blur && !!coverSrc);
    blur.hidden = !appearance.blur || !coverSrc;
    if (!blur.hidden) blur.src = coverSrc;
    blur.onerror = () => { blur.hidden = true; root.dataset.coverBlur = 'false'; };
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
    $('[data-statuses]').replaceChildren();
    $('[data-age-rating]').replaceChildren();
    $('[data-age-row]').hidden = true;
    $('[data-publication-row]').hidden = media;
    const level = Number(meta.content_rating_level);
    if (coreState?.showContentRatingBadge === true && Number.isFinite(level)) {
      const badge = node('span', 'ds-chip ds-rating');
      badge.dataset.level = String(level);
      badge.title = '열람 등급';
      const shield = node('i', 'fa-solid fa-shield-halved');
      shield.setAttribute('aria-hidden', 'true');
      badge.append(shield, document.createTextNode(meta.content_rating_label || (level === 0 ? '전체이용가' : level === 15 ? '15세이상' : '18세이상(성인)')));
      $('[data-age-rating]').append(badge);
      $('[data-age-row]').hidden = false;
    }
    if (!media) {
      const label = meta.publication_status_label || '알 수 없음';
      const badge = node('span', 'ds-chip ds-publication'); badge.dataset.status = label; badge.title = '연재 상태';
      const icon = node('i', 'fa-solid fa-bookmark'); icon.setAttribute('aria-hidden', 'true');
      badge.append(icon, document.createTextNode(label)); $('[data-statuses]').append(badge);
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
  let noticeTimer;
  function notify(message, error = false) {
    const el = $('[data-notice]');
    el.textContent = message;
    el.dataset.error = String(error);
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { el.hidden = true; }, error ? 7000 : 4000);
  }
  async function request(url, options = {}) {
    const readOnly = (options.method || 'GET').toUpperCase() === 'GET';
    for (let attempt = 0; ; attempt++) {
      try {
        let response;
        try { response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(20000), ...options }); }
        catch { throw Object.assign(new Error('서버에 연결하지 못했거나 응답 시간이 초과되었습니다.'), {retryable:true}); }
        if (response.status === 401 || (response.redirected && /\/login\/?$/.test(new URL(response.url).pathname))) throw new Error('로그인이 필요합니다. 로그인 상태를 확인해 주세요.');
        let data;
        try { data = await response.json(); }
        catch { throw Object.assign(new Error(`서버가 올바른 데이터 응답을 반환하지 않았습니다. (HTTP ${response.status})`), {retryable:response.status !== 403}); }
        if (!response.ok || !data?.success) throw Object.assign(new Error(data?.error || data?.message || `요청 실패 (${response.status})`), {retryable:response.status >= 500});
        return data;
      } catch (error) {
        if (!readOnly || attempt > 0 || !error.retryable || !root.isConnected) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
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
  function canListen(book) {
    return ['general', 'adult'].includes(type) && !!book && typeof window.openListen === 'function' && typeof window.canListen === 'function' && window.canListen(book.file_format);
  }
  async function listen(book) {
    if (!canListen(book) || !allowNavigation()) return;
    try { await window.openListen(Number(book.id), type); }
    catch { notify('듣기 화면을 열지 못했습니다. 다시 시도해 주세요.', true); }
  }
  function setupPreferences() {
    const sizes = {};
    try { Object.assign(sizes, JSON.parse(localStorage.getItem(`${pluginId}:sizes`) || '{}')); } catch {}
    const specs = [['shelf', '시리즈 둘러보기', 180, 90, 320], ['grid', '시리즈 표지 보기', 150, 90, 300], ['list', '시리즈 목록 보기', 80, 50, 160]];
    function updatePreview() {
      $('[data-size-preview]').replaceChildren(...specs.map(([key, label, fallback]) => {
        const item = node('div', '', label), img = node('img');
        const src = safeUrl(meta.cover_image || books[0]?.cover_image, true);
        if (src) img.src = src;
        img.alt = `${label} 미리보기`; img.style.width = `${sizes[key] || fallback}px`;
        item.append(img); return item;
      }));
    }
    for (const [key, label, fallback, min, max] of specs) {
      const row = node('div', 'ds-size-control');
      const range = node('input'), number = node('input');
      range.type = 'range'; number.type = 'number';
      const initial = Number(sizes[key]);
      if (Number.isFinite(initial) && initial >= min && initial <= max) root.style.setProperty(`--ds-${key}-size`, `${initial}px`);
      else delete sizes[key];
      for (const input of [range, number]) {
        input.min = min; input.max = max; input.value = sizes[key] || fallback;
        input.setAttribute('aria-label', label);
        input.addEventListener(input === range ? 'input' : 'change', () => {
          if (!input.value || !Number.isFinite(Number(input.value))) { input.value = sizes[key] || fallback; return; }
          const value = Math.min(max, Math.max(min, Number(input.value)));
          sizes[key] = value; range.value = number.value = value;
          root.style.setProperty(`--ds-${key}-size`, `${value}px`);
          try { localStorage.setItem(`${pluginId}:sizes`, JSON.stringify(sizes)); } catch {}
          updatePreview();
        });
      }
      row.append(node('span', '', label), range, number); $('[data-size-settings]').append(row);
    }
    $('[data-size-reset]').addEventListener('click', () => {
      specs.forEach(([key, , fallback], i) => {
        delete sizes[key]; root.style.removeProperty(`--ds-${key}-size`);
        $('[data-size-settings]').children[i].querySelectorAll('input').forEach(input => input.value = fallback);
      });
      try { localStorage.removeItem(`${pluginId}:sizes`); } catch {}
      updatePreview();
    });
    updatePreview();
  }
  function setupMenuAutoHide() {
    const input = $('[data-auto-hide-menu]'), bar = $('.ds-topbar');
    const desktop = window.matchMedia('(min-width:701px) and (hover:hover)');
    let timer;
    try { input.checked = localStorage.getItem(`${pluginId}:auto-hide-menu`) === 'true'; } catch {}
    const reset = () => {
      clearTimeout(timer);
      root.dataset.menuHidden = 'false';
      if (!input.checked || !desktop.matches) return;
      timer = setTimeout(() => {
        if (!bar.matches(':hover') && !bar.contains(document.activeElement)) root.dataset.menuHidden = 'true';
      }, 5000);
    };
    input.addEventListener('change', () => {
      try { localStorage.setItem(`${pluginId}:auto-hide-menu`, String(input.checked)); } catch {}
      reset();
    });
    root.addEventListener('click', reset);
    for (const event of ['mouseenter', 'mouseleave', 'focusin', 'focusout']) bar.addEventListener(event, reset);
    desktop.addEventListener('change', reset);
    reset();
    return () => { clearTimeout(timer); desktop.removeEventListener('change', reset); };
  }
  function setupLayout() {
    const rail = $('[data-rail-details]'), overview = $('.ds-overview-grid');
    const factsCard = $('.ds-facts'), heading = $('.ds-heading'), ratings = $('.ds-detail-ratings'), chips = $('[data-chips]');
    const choice = $('select[data-info-position]');
    const mobile = window.matchMedia('(max-width:700px)');
    const panel = $('#ds-panel-overview'), shelf = $('[data-preview-books]'), shelfHeading = shelf.previousElementSibling;
    try { choice.value = localStorage.getItem(`${pluginId}:info-position`) === 'cover' ? 'cover' : 'header'; } catch {}
    const apply = () => {
      const below = choice.value === 'cover';
      root.dataset.infoPosition = choice.value;
      (below && !mobile.matches ? rail : overview).append(factsCard);
      (below ? factsCard : heading).append(ratings, chips);
      factsCard.append($('[data-site-link]'));
      if (mobile.matches) {
        $('.ds-layout').prepend(heading);
        panel.append(shelfHeading, shelf, $('#ds-panel-similar'), factsCard);
      } else {
        $('.ds-main').prepend(heading);
        panel.append(shelfHeading, shelf, $('#ds-panel-similar'));
      }
      requestAnimationFrame(fitSummary);
    };
    choice.addEventListener('change', () => { apply(); try { localStorage.setItem(`${pluginId}:info-position`, choice.value); } catch {} });
    $('[data-edit-shortcut]').addEventListener('click', () => { if (!canEdit || saving) return; selectTab('metadata'); if ($('[data-edit-form]').hidden) editMode(true); });
    apply();
    mobile.addEventListener('change', apply);
    const back = container.closest('#book-detail-view')?.querySelector(':scope > .btn-back-to-list');
    if (!back) return () => mobile.removeEventListener('change', apply);
    const marker = document.createComment('Detail Studio back button'); back.before(marker);
    $('[data-back-slot]').hidden = false; $('[data-back-slot]').append(back);
    return () => { mobile.removeEventListener('change', apply); if (marker.isConnected) marker.replaceWith(back); };
  }
  let collectionLoading = false, collectionWriting = false;
  async function toggleCollections() {
    const panel = $('[data-collection-menu]'), toggle = $('[data-action=collection]');
    if (saving || collectionWriting || !books.length) return;
    panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden || collectionLoading) return;
    collectionLoading = true;
    panel.replaceChildren(node('p', '', '컬렉션을 불러오는 중…'));
    const params = new URLSearchParams({db_type:type});
    const payload = media ? {[type === 'audiobook' ? 'audiobook_id' : 'video_id']: Number(meta.id)} : {series_name:meta.series_name || context.seriesName};
    const add = async (id, items = []) => {
      if (saving || collectionWriting) return;
      collectionWriting = true;
      panel.querySelectorAll('button').forEach(button=>{button.disabled=true;});
      try {
        if (items.length) {
          for (const item of items) await request(`/api/v1/collections/${encodeURIComponent(id)}/items/${encodeURIComponent(item.id)}?${params}`, {method:'DELETE'});
        } else await request(`/api/v1/collections/${encodeURIComponent(id)}/items?${params}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        panel.hidden = true; toggle.setAttribute('aria-expanded','false'); notify(items.length ? '컬렉션에서 제거했습니다.' : '컬렉션에 추가했습니다.');
      } catch(error) { panel.hidden = true; toggle.setAttribute('aria-expanded','false'); notify(error.message + ' 컬렉션을 다시 열어 현재 상태를 확인해 주세요.', true); }
      finally { collectionWriting = false; panel.querySelectorAll('button').forEach(button=>{button.disabled=false;}); }
    };
    try {
      const data = await request('/api/v1/collections?' + params);
      const collections = await Promise.all((data.collections || []).map(async collection => {
        const detail = await request(`/api/v1/collections/${encodeURIComponent(collection.id)}?${params}`);
        if (!Array.isArray(detail.collection?.items)) throw new Error('컬렉션 포함 상태를 확인하지 못했습니다.');
        return {...collection, items: detail.collection.items.filter(item => media ? Number(item[type === 'audiobook' ? 'audiobook_id' : 'video_id']) === Number(meta.id) : item.series_name === payload.series_name || books.some(book => Number(book.id) === Number(item.book_id)))};
      }));
      if (!root.isConnected) return;
      panel.replaceChildren();
      for (const collection of collections) {
        const button = node('button', 'ds-collection-option', `${collection.name} · ${num(collection.item_count)}개`); button.type='button';
        const dot = node('span', 'ds-collection-color'); dot.setAttribute('aria-hidden', 'true');
        dot.style.backgroundColor = CSS.supports('color', collection.color) ? collection.color : '#7c3aed';
        button.prepend(dot);
        button.setAttribute('aria-pressed', String(collection.items.length > 0));
        button.title = collection.items.length ? '클릭하여 컬렉션에서 제거' : '클릭하여 컬렉션에 추가';
        if (collection.items.length) button.append(icon('check'));
        button.addEventListener('click',()=>add(collection.id, collection.items)); panel.append(button);
      }
      if (!data.collections?.length) panel.append(node('p','','아직 컬렉션이 없습니다.'));
      const create = node('button','ds-collection-option','+ 새 컬렉션'); create.type='button';
      create.addEventListener('click', async()=>{
        try { const {openCreateCollectionModal} = await import('/static/js/tab_collections.js'); if(root.isConnected) openCreateCollectionModal(id => add(id)); }
        catch { notify('컬렉션 만들기를 열지 못했습니다.',true); }
      }); panel.append(create);
    } catch(error) { panel.replaceChildren(node('p','',error.message)); }
    finally { collectionLoading=false; }
  }
  async function loadRating() {
    const target = $('[data-stars]');
    const score = Math.max(0, Math.min(5, Math.round(num(meta.score) / 10) / 2));
    const starIcon = (filled, half = false) => {
      const star = node('i', half ? 'fa-solid fa-star-half-stroke' : `fa-${filled ? 'solid' : 'regular'} fa-star`);
      star.setAttribute('aria-hidden', 'true');
      return star;
    };
    target.setAttribute('aria-label', `도서 평점 ${score}점 / 5점`);
    target.replaceChildren(...[1,2,3,4,5].map(value => starIcon(value <= score, value > score && value - .5 === score)));
    if (type !== 'general') return;
    const ratingContext = {seriesName: meta.series_name || context.seriesName, libraryId: libraryId ?? context.libraryId, bookId: books[0]?.id, author: meta.author || '', isbn: meta.isbn || ''};
    try {
      const api = await import('/static/js/api.js');
      let data = await api.fetchRatingWidget(type, ratingContext);
      if (!root.isConnected || !data.success) return;
      let submitting = false;
      function draw() {
        const mine = Math.max(0, Math.min(5, Math.round(num(data.my_rating) * 2) / 2));
        target.setAttribute('aria-label', `내 평점 ${mine}점 / 5점`);
        target.replaceChildren(...Array.from({length:10}, (_,i)=>(i+1)/2).map(value => {
          const button = node('button', `ds-star-half ${Number.isInteger(value) ? 'ds-star-right' : 'ds-star-left'}`); button.type = 'button'; button.append(starIcon(value <= mine));
          button.title = `${value}점`;
          button.disabled = submitting;
          button.setAttribute('aria-label', `${value}점`); button.setAttribute('aria-pressed', String(value === mine));
          button.addEventListener('click', async () => {
            if (submitting || saving) return;
            submitting = true; draw();
            try {
              const result = await api.submitRating(type, ratingContext, value);
              if (!result.success) throw new Error(result.error || '별점 저장에 실패했습니다.');
              data = {...data, ...result};
            } catch (error) { if (root.isConnected) notify(error.message || '별점 저장에 실패했습니다.', true); }
            finally { submitting = false; if (root.isConnected) draw(); }
          });
          return button;
        }));
        if (num(data.count)) target.append(node('small', 'ds-rating-summary', `${num(data.count)}명 · 평균 ${num(data.average).toFixed(1)}`));
      }
      draw();
    } catch { /* 활성 제공자가 없거나 연결 실패 시 코어 점수 별표를 유지한다. */ }
  }
  function fitSummary() {
    const card = $('.ds-synopsis'), paragraph = $('[data-summary]'), button = $('[data-action=summary]');
    if (!card.offsetWidth) return;
    const info = $('.ds-facts').getBoundingClientRect(), box = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    const overhead = paragraph.getBoundingClientRect().top - box.top + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
    const available = root.dataset.infoPosition !== 'cover' && Math.abs(info.top - box.top) < 2 ? info.height - overhead : parseFloat(getComputedStyle(paragraph).lineHeight) * 7;
    const overflow = paragraph.scrollHeight > available + 1;
    button.hidden = !overflow;
    const reserve = overflow ? button.offsetHeight + parseFloat(getComputedStyle(button).marginTop) : 0;
    paragraph.style.setProperty('--ds-summary-height', `${Math.max(24, available - reserve)}px`);
    paragraph.classList.toggle('ds-clamped', overflow && button.getAttribute('aria-expanded') !== 'true');
  }
  function bindBookMenu(target, book) {
    if (media || !book) return;
    target.title = `${title(book)} · 우클릭 또는 길게 눌러 도서 메뉴`;
    target.classList.add('ds-book-menu-target');
    let suppressClickUntil = 0;
    const showMenu = (x, y) => {
      if (!target.isConnected) return;
      if (dirty || saving) return notify('편집을 저장하거나 취소한 후 도서 메뉴를 열어 주세요.');
      if (typeof window.showBookContextMenu !== 'function') return notify('코어 도서 메뉴를 연결하지 못했습니다. 페이지를 새로고침해 주세요.', true);
      window.showBookContextMenu(x, y, Number(book.id), title(book), true, {
        seriesName: meta.series_name || context.seriesName,
        libraryId: book.library_id ?? libraryId ?? context.libraryId,
        markUnreadScope: 'book',
      });
      notify('메뉴에서 표지·메타정보·읽기 상태를 변경했다면 상세페이지를 다시 열어 최신 정보를 확인해 주세요.');
    };
    target.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() >= suppressClickUntil) showMenu(event.clientX, event.clientY);
    });
    target.addEventListener('touchstart', event => {
      if (event.target.closest('.ds-book-listen')) return;
      window.handleLongPressTouchStart?.(event, (x, y) => {
        suppressClickUntil = Date.now() + 900;
        showMenu(x, y);
      });
    }, {passive:false});
    target.addEventListener('touchmove', event => window.handleLongPressTouchMove?.(event), {passive:true});
    for (const name of ['touchend', 'touchcancel']) target.addEventListener(name, event => {
      window.handleLongPressTouchEnd?.(event);
      if (Date.now() < suppressClickUntil) {
        suppressClickUntil = Date.now() + 900;
        if (event.cancelable) event.preventDefault();
      }
    }, {passive:false});
    target.addEventListener('click', event => {
      if (Date.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
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
      bindBookMenu(card, book);
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
    if (!recommended && canListen(book)) {
      const audio = node('button', 'ds-button ds-listen ds-book-listen');
      audio.type = 'button';
      audio.setAttribute('aria-label', `${label} 듣기`);
      audio.append(icon('headphones'), document.createTextNode('듣기'));
      audio.addEventListener('click', event => { event.stopPropagation(); listen(book); });
      card.append(audio);
    }
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
    facts($('[data-metadata]'), [['시리즈명', meta.series_name || context.seriesName], ...fields.map(([key, label]) => [label, key === 'publication_status' ? meta.publication_status_label || '알 수 없음' : meta[key]]), ...(!media ? [['카테고리 속성', contentKindName || contentKind || '미지정']] : []), ['책 소개', meta.summary], ['메타정보 잠금', Number(meta.metadata_locked) === 1 ? '잠김' : '잠금 해제']]);
    const links = String(meta.link || '').split(/[,\n]+/).map(value => safeUrl(value.trim())).filter(Boolean);
    const shortcut = $('[data-site-link]');
    const external = links.find(link => /^https?:\/\//i.test(link) && !new URL(link).username && !new URL(link).password);
    shortcut.hidden = !external;
    shortcut.removeAttribute('href');
    if (external) {
      const host = new URL(external).hostname.replace(/^www\./, '');
      const sites = {'ridibooks.com':'리디북스', 'ridi.com':'리디', 'yes24.com':'YES24', 'aladin.co.kr':'알라딘', 'kyobobook.co.kr':'교보문고', 'booklive.jp':'BookLive', 'amazon.co.jp':'Amazon', 'amazon.com':'Amazon', 'kakao.com':'카카오', 'naver.com':'네이버'};
      const domain = Object.keys(sites).find(domain => host === domain || host.endsWith('.' + domain));
      const label = `${sites[domain] || host} 바로가기`;
      shortcut.title = label; shortcut.setAttribute('aria-label', label);
      const favicon = node('img'); favicon.alt = ''; favicon.width = 20; favicon.height = 20;
      favicon.referrerPolicy = 'no-referrer';
      favicon.addEventListener('error', () => favicon.replaceWith(icon('arrow-up-right-from-square')), {once:true});
      favicon.src = new URL('/favicon.ico', external).href;
      shortcut.replaceChildren(favicon);
      shortcut.href = external;
    }
    const linkIndex = fields.findIndex(([key]) => key === 'link');
    if (links.length && linkIndex >= 0) {
      const dd = $('[data-metadata]').children[linkIndex + 1].querySelector('dd');
      dd.replaceChildren(...links.map(link => {
        const anchor = node('a', '', link); anchor.href = link;
        anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.style.display = 'block'; return anchor;
      }));
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
    $('[data-listen-first]').hidden = !canListen(books[0]);
    $('[data-listen-first]').onclick = () => listen(books[0]);
    const favorite = $('[data-action=favorite]');
    favorite.disabled = !books.length;
    favorite.setAttribute('aria-pressed', String(books.length > 0 && books.every((book) => Number(book.is_favorite) === 1)));
    favorite.title = '시리즈 즐겨찾기';
    favorite.querySelector('i').className = favorite.getAttribute('aria-pressed') === 'true' ? 'fa-solid fa-star' : 'fa-regular fa-star';
    $('[data-summary]').textContent = meta.summary || '등록된 책 소개가 없습니다.';
    $('[data-summary]').classList.remove('ds-clamped');
    requestAnimationFrame(fitSummary);
    $('[data-action=summary]').setAttribute('aria-expanded', 'false');
    $('[data-action=summary]').textContent = '더 보기';
    facts($('[data-facts]'), [['출판사', meta.publisher], ['ISBN / WEB ID', meta.isbn], ['소장 도서', `${books.length}${unit}`], ['파일 크기', filesLoaded ? bytes(books.reduce((sum, book) => sum + num(extras.get(Number(book.id))?.file_size ?? book.file_size), 0)) : '확인 중'], ...(!media ? [['카테고리 속성', contentKindName || contentKind || '미지정'], ['그림 작가', meta.cover_artist], ...(contentKind === 'book' ? [['출간일',meta.release_date]] : [['연재 시작일',meta.publication_start_date],['연재 종료일',meta.publication_end_date]]), ['회차 수',meta.manual_chapter_count]] : []), ...(media ? [['재생 시간', `${Math.floor(num(meta.total_duration) / 3600)}시간 ${Math.floor(num(meta.total_duration) % 3600 / 60)}분`]] : [])]);
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
    $('[data-preview-books]').replaceChildren(...books.map((book, index) => bookCard(book, index)));
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
      contentKind = data.content_kind || ''; contentKindName = data.content_kind_name || '';
      extendedReady = !media && !!data.extended_metadata;
      if (extendedReady) {
        Object.assign(meta, data.extended_metadata);
        meta.publication_status_label = ({'0':'연재','1':'휴재','2':'완결'})[meta.publication_status] || '알 수 없음';
      }
      $('[data-edit-shortcut]').hidden = !canEdit;
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
    if (tab === 'overview') loadSimilar();
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
    for (const [key] of extraFields) if (form.elements[key]) form.elements[key].disabled = !extendedReady;
    for (const key of ['publication_start_date','publication_end_date','release_date']) if(form.elements[key]) form.elements[key].closest('label').hidden = key === 'release_date' ? contentKind !== 'book' : contentKind === 'book';
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
    const file = data.get('cover_image');
    if (file?.size && (file.size > 10 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) return notify('표지는 10MB 이하의 JPG, PNG, WebP 파일을 선택해 주세요.', true);
    if (!file?.size) data.delete('cover_image');
    const link = String(data.get('link') || '').trim();
    if (link && !/^https?:\/\//i.test(link)) return notify('관련 링크는 http:// 또는 https:// 주소로 입력해 주세요.', true);
    data.set('type', type); data.set('series', meta.series_name || context.seriesName);
    if (!media && extendedReady) {
      const start = data.get('publication_start_date'), end = data.get('publication_end_date');
      if (start && end && start > end) return notify('연재 종료일이 시작일보다 빠릅니다.', true);
    }
    saving = true;
    all('[data-edit-form] button, [data-edit-form] input, [data-edit-form] textarea, [data-edit-form] select').forEach((el) => { el.disabled = true; });
    let coreSaved = false;
    try {
      await request('/api/media/detail/edit', { method: 'POST', body: data });
      if (!root.isConnected) return;
      coreSaved = true;
      if (!media && extendedReady) await request('/api/media/context-menu/book/plugins/action', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({plugin_id:pluginId, action_id:'save_metadata', type, context:{series_name:meta.series_name || context.seriesName, ...Object.fromEntries(extraFields.map(([key])=>[key,String(data.get(key) || '')]))}})});
      for (const [key] of fields) if(data.has(key)) meta[key] = String(data.get(key) || '');
      meta.summary = String(data.get('summary') || ''); meta.metadata_locked = type === 'audiobook' ? 0 : 1;
      dirty = false; similarLoaded = false;
      // 저장 성공과 이후 새로고침 실패를 구분해 중복 저장을 피한다.
      let refreshed = true;
      try {
        const result = await request('/api/media/detail?' + new URLSearchParams({ type, series: context.seriesName, library_id: context.libraryId || 'all', representative_book_id: media ? meta.id : books[0]?.id || '' }));
        if (result.meta) Object.assign(meta, result.meta);
      } catch { refreshed = false; }
      saving = false;
      editMode(false); await loadFiles(); renderHeader();
      notify(refreshed ? '시리즈 메타정보를 저장했습니다.' : '저장은 완료했습니다. 최신 표지는 페이지를 다시 열면 확인할 수 있습니다.');
    } catch (error) { if (root.isConnected) notify(`${coreSaved ? '기본 정보는 저장됐지만 추가 정보 저장에 실패했습니다.' : '저장하지 못했습니다.'} 입력 내용은 유지됩니다. ${error.message}`, true); }
    finally {
      saving = false;
      all('[data-edit-form] button, [data-edit-form] input, [data-edit-form] textarea, [data-edit-form] select').forEach((el) => { el.disabled = !extendedReady && extraFields.some(([key])=>key === el.name); });
    }
  }
  try {
    const { state } = await import('/static/js/state.js');
    if (!root.isConnected) return;
    coreState = state;
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
    if (!media) { fields.splice(4, 0, ['books_lv', '도서 등급 (books_lv)']); fields.push(...extraFields); }
    for (const [key, label] of fields) {
      const field = node('label', 'ds-field', label), input = node(['books_lv','publication_status'].includes(key) ? 'select' : 'input');
      if (key === 'books_lv') {
        for (const value of ['', 'everyone', '일반', 'ma15+', 'm', '15세', 'r18', 'adult only', '18세']) {
          const option = node('option', '', value || '미지정 (전체이용가)');
          option.value = value; input.append(option);
        }
      }
      if (key === 'publication_status') {
        for (const [value, text] of [['','알 수 없음'],['0','연재'],['1','휴재'],['2','완결']]) { const option = node('option', '', text); option.value = value; input.append(option); }
      }
      input.name = key;
      if (!['books_lv','publication_status'].includes(key)) { input.type = key.endsWith('_date') ? 'date' : key === 'manual_chapter_count' ? 'number' : 'text'; input.maxLength = key === 'link' ? 2000 : 4000; }
      if (key === 'manual_chapter_count') { input.min = '1'; input.max = '1000000'; input.step = '1'; }
      if (key.endsWith('_date') || key === 'manual_chapter_count') field.append(node('small', '', 'Detail Studio 전용 값 · 코어 자동 스캔에는 적용되지 않습니다.'));
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
    $('[data-action=collection]').addEventListener('click', toggleCollections);
    $('[data-collection-menu]').addEventListener('keydown', event => { if(event.key === 'Escape') { $('[data-collection-menu]').hidden=true; $('[data-action=collection]').setAttribute('aria-expanded','false'); $('[data-action=collection]').focus(); } });
    $('[data-action=show-files]').addEventListener('click', () => selectTab('files', true));
    $('[data-action=show-series]').addEventListener('click', () => selectTab('series', true));
    $('[data-action=summary]').addEventListener('click', (event) => {
      const expanded = event.currentTarget.getAttribute('aria-expanded') !== 'true';
      event.currentTarget.setAttribute('aria-expanded', String(expanded)); event.currentTarget.textContent = expanded ? '접기' : '더 보기';
      fitSummary();
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
    const restoreBack = setupLayout();
    const cleanupMenuAutoHide = setupMenuAutoHide();
    const summaryObserver = new ResizeObserver(fitSummary);
    summaryObserver.observe($('.ds-facts'));
    summaryObserver.observe($('.ds-overview-grid'));
    const observer = new MutationObserver(() => {
      if (root.isConnected) return;
      document.removeEventListener('click', stopNavigation, true); window.removeEventListener('beforeunload', beforeUnload); observer.disconnect(); summaryObserver.disconnect(); clearTimeout(noticeTimer); restoreBack(); cleanupMenuAutoHide();
    });
    observer.observe(container.parentNode || document.body, { childList: true, subtree: true });
    bindBookMenu($('.ds-cover'), books[0]);
    setupPreferences();
    renderHeader(); renderSeries(); renderFiles();
    root.dataset.ready = 'true';
    await loadFiles();
    loadRating();
    loadSimilar();
  } catch (error) { notify(`상세 화면을 불러오지 못했습니다. ${error.message}`, true); }
})();
