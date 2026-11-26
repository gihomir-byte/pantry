/* =========================================================
   냉큼 공통 컴포넌트 도우미 (window.nk)
   - 빌드 없이 <script src="/design-system/nk.js"></script> 로 불러요.
   - HTML 문자열을 만드는 함수는 지금 index.html처럼 innerHTML에 넣어 쓰면 돼요.
   - 글자는 전부 이스케이프해요. onClick 같은 '동작' 자리에는 코드 문자열을 넣어요.
   ========================================================= */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attr = (s) => esc(s);

  /* ---------- Button ---------- */
  // 버튼 HTML. variant: 'primary' | 'secondary' | 'text', tone: 'danger', size: 'sm', block: true
  function button({ label, variant = 'primary', tone, size, block, onClick, type = 'button', disabled, id } = {}) {
    const cls = ['nk-btn', `nk-btn--${variant}`, tone && `nk-btn--${tone}`, size && `nk-btn--${size}`, block && 'nk-btn--block'].filter(Boolean).join(' ');
    return `<button type="${attr(type)}" class="${cls}"${id ? ` id="${attr(id)}"` : ''}${onClick ? ` onclick="${attr(onClick)}"` : ''}${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
  }

  // 저장 버튼을 누르면 끝날 때까지 잠가요. 두 번 눌러도 한 번만 실행돼요.
  // 사용: nk.withLoading(btn, async () => { await 저장(); })
  async function withLoading(btn, fn) {
    if (!btn || btn.getAttribute('aria-busy') === 'true') return undefined;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try {
      return await fn();
    } finally {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  }

  /* ---------- TextField ---------- */
  let fieldSeq = 0;
  // 라벨·입력칸·도움말·에러 자리까지 한 번에. optional: true 면 라벨 옆에 '(선택)'
  function textField({ label, name, id, type = 'text', value = '', placeholder = '', help = '', optional, required, inputmode, autocomplete, maxlength } = {}) {
    const fid = id || `nk-f${++fieldSeq}`;
    const helpId = `${fid}-help`, errId = `${fid}-err`;
    const extra = [
      name && `name="${attr(name)}"`,
      inputmode && `inputmode="${attr(inputmode)}"`,
      autocomplete && `autocomplete="${attr(autocomplete)}"`,
      maxlength && `maxlength="${Number(maxlength)}"`,
      required && 'required',
    ].filter(Boolean).join(' ');
    return `<div class="nk-field">
  <label class="nk-field__label" for="${attr(fid)}">${esc(label)}${optional ? ' <span class="nk-field__optional">(선택)</span>' : ''}</label>
  <input class="nk-field__input" id="${attr(fid)}" type="${attr(type)}" value="${attr(value)}" placeholder="${attr(placeholder)}" aria-describedby="${help ? helpId + ' ' : ''}${errId}" ${extra}>
  ${help ? `<p class="nk-field__help" id="${helpId}">${esc(help)}</p>` : ''}
  <p class="nk-field__error" id="${errId}" role="alert"></p>
</div>`;
  }

  // 입력칸 아래에 에러를 보여 주고(빈 문자열이면 지움) 칸에 빨간 테두리를 그려요.
  function setFieldError(input, message) {
    if (typeof input === 'string') input = document.getElementById(input);
    if (!input) return;
    const field = input.closest('.nk-field');
    const err = field && field.querySelector('.nk-field__error');
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      if (err) err.textContent = message;
    } else {
      input.removeAttribute('aria-invalid');
      if (err) err.textContent = '';
    }
  }

  /* ---------- Card / ListItem ---------- */
  // body: 아무 HTML, list: ListItem HTML(카드 끝까지 닿게 배치), action: 제목 오른쪽 버튼 HTML
  function card({ title, desc, action, body = '', list = '', flush } = {}) {
    const head = title || action ? `<div class="nk-card__head"><h3 class="nk-card__title">${esc(title || '')}</h3>${action || ''}</div>` : '';
    return `<section class="nk-card${flush ? ' nk-card--flush' : ''}">${head}${desc ? `<p class="nk-card__desc">${esc(desc)}</p>` : ''}${body}${list ? `<div class="nk-card__list">${list}</div>` : ''}</section>`;
  }

  const CHEVRON = '<svg class="nk-icon nk-list-item__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
  // lead: 이모지나 아이콘 HTML, trail: 오른쪽 HTML(버튼·알약), onClick 있으면 줄 전체가 눌려요
  function listItem({ lead, title, desc, trail = '', onClick, chevron } = {}) {
    const tag = onClick ? 'button' : 'div';
    const leadHtml = lead ? `<span class="nk-list-item__lead" aria-hidden="true">${lead}</span>` : '';
    return `<${tag} class="nk-list-item"${onClick ? ` type="button" onclick="${attr(onClick)}"` : ''}>${leadHtml}<span class="nk-list-item__body"><span class="nk-list-item__title">${esc(title)}</span>${desc ? `<span class="nk-list-item__desc">${esc(desc)}</span>` : ''}</span>${trail || chevron ? `<span class="nk-list-item__trail">${trail}${chevron ? CHEVRON : ''}</span>` : ''}</${tag}>`;
  }

  /* ---------- Skeleton ---------- */
  // kind: 'list'(줄 n개) | 'card'(큰 상자) | 'text'(글 줄 n개)
  function skeleton({ kind = 'list', rows = 3 } = {}) {
    const label = '<span class="nk-sr-only">불러오고 있어요</span>';
    if (kind === 'card') return `<div role="status" aria-busy="true">${label}<span class="nk-skeleton nk-skeleton--box"></span></div>`;
    if (kind === 'text') return `<div role="status" aria-busy="true" style="display:grid;gap:var(--nk-space-8)">${label}${Array.from({ length: rows }, (_, i) => `<span class="nk-skeleton nk-skeleton--text${i === rows - 1 ? ' is-short' : ''}"></span>`).join('')}</div>`;
    return `<div role="status" aria-busy="true">${label}${Array.from({ length: rows }, () => '<div class="nk-skeleton-row"><span class="nk-skeleton nk-skeleton--circle"></span><div><span class="nk-skeleton nk-skeleton--text"></span><span class="nk-skeleton nk-skeleton--text is-short"></span></div></div>').join('')}</div>`;
  }

  /* ---------- EmptyState / ErrorState ---------- */
  // 행동 버튼은 하나만. 할 일이 없으면 actionLabel 을 비워요.
  function emptyState({ icon = '🧊', title, desc, actionLabel, onAction, compact } = {}) {
    return `<div class="nk-state${compact ? ' nk-state--compact' : ''}">
  <div class="nk-state__icon" aria-hidden="true">${icon}</div>
  <p class="nk-state__title">${esc(title)}</p>
  ${desc ? `<p class="nk-state__desc">${esc(desc)}</p>` : ''}
  ${actionLabel ? `<div class="nk-state__action">${button({ label: actionLabel, variant: 'primary', onClick: onAction })}</div>` : ''}
</div>`;
  }

  // 무슨 일 + 어떻게 하면 되는지 + [다시 해 보기]. 개발자용 메시지는 절대 넣지 않아요.
  function errorState({ icon = '!', title = '불러오지 못했어요', desc = '인터넷 연결을 확인하고 다시 해 주세요.', retryLabel = '다시 해 보기', onRetry, compact } = {}) {
    return `<div class="nk-state nk-state--error${compact ? ' nk-state--compact' : ''}" role="alert">
  <div class="nk-state__icon" aria-hidden="true">${esc(icon)}</div>
  <p class="nk-state__title">${esc(title)}</p>
  ${desc ? `<p class="nk-state__desc">${esc(desc)}</p>` : ''}
  ${onRetry ? `<div class="nk-state__action">${button({ label: retryLabel, variant: 'secondary', onClick: onRetry })}</div>` : ''}
</div>`;
  }

  // 오류 객체를 사람이 읽는 말로 바꿔요. 원래 메시지는 console에만 남겨요.
  function errorText(error, what = '저장') {
    if (error) console.warn('[nk]', error);
    const m = String((error && (error.message || error.error)) || error || '');
    const status = error && (error.status || (error.context && error.context.status));
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return '인터넷이 끊겼어요. 연결되면 다시 해 주세요.';
    if (/failed to fetch|network|load failed|networkerror/i.test(m)) return '인터넷 연결이 불안해요. 잠시 후 다시 해 주세요.';
    if (status === 429 || status === 503 || /rate|busy|too many/i.test(m)) return '지금 사용하는 사람이 많아요. 1분 뒤에 다시 해 주세요.';
    if (status === 504 || /timeout|timed out|지연/i.test(m)) return '시간이 너무 오래 걸렸어요. 다시 해 주세요.';
    if (status === 401 || /jwt|auth|login/i.test(m)) return '로그인이 풀렸어요. 다시 로그인해 주세요.';
    return `${what}하지 못했어요. 잠시 후 다시 해 주세요.`;
  }

  /* ---------- Toast ---------- */
  let region = null;
  function ensureRegion() {
    if (region && document.body.contains(region)) return region;
    region = document.createElement('div');
    region.className = 'nk-toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
    return region;
  }
  // nk.toast('저장했어요')  /  nk.toast('지웠어요', { actionLabel: '되돌리기', onAction: () => ... })
  // 한 번에 하나만 보여요. 행동 버튼이 있으면 5초, 없으면 2.5초.
  function toast(message, { actionLabel, onAction, duration } = {}) {
    const r = ensureRegion();
    r.querySelectorAll('.nk-toast').forEach((t) => t.remove());
    const el = document.createElement('div');
    el.className = 'nk-toast';
    el.innerHTML = `<span class="nk-toast__msg">${esc(message)}</span>${actionLabel ? `<button type="button" class="nk-toast__action">${esc(actionLabel)}</button>` : ''}`;
    r.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-shown'));
    let timer;
    const hide = () => {
      clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 260);
    };
    if (actionLabel) {
      el.querySelector('.nk-toast__action').addEventListener('click', () => { hide(); if (onAction) onAction(); }, { once: true });
    }
    timer = setTimeout(hide, duration || (actionLabel ? 5000 : 2500));
    return { hide };
  }

  window.nk = { esc, button, withLoading, textField, setFieldError, card, listItem, skeleton, emptyState, errorState, errorText, toast };
})();
