// ── Card definitions ──
const CARDS = [
  { id: 1, img: './files/card-static1.webp' },
  { id: 2, img: './files/card-static2.webp' },
  { id: 3, img: './files/card-static3.webp' },
  { id: 4, img: './files/card-static4.webp' },
];
const CARD_BACK_IMG = './files/card-back.webp';

// x/y: percentages of the card's own width/height (used in CSS translate)
// All values adapt to the three layout breakpoints (matches index.html design widths)
//
//              手机 390px  |  平板 768px  |  电脑 1440px
//  main  y         10     |     10       |     10
//  stack y        105     |    108       |    112       ← 叠牌越大屏幕越低
//  stack x          0     |      0       |      0
//  rot            ±20     |    ±16       |    ±12
function computePositions() {
  const vw = window.innerWidth;

  const mainY  = 10;

  const stackY = vw >= 1024 ? 98
               : vw >= 600  ? 100
                            : 100;

  // const stackX = 0;

  const stackX    = vw >= 1024 ? 40
                : vw >= 600  ? 30
                            : 0;

  const rot    = vw >= 1024 ? 30
               : vw >= 600  ? 30
                            : 20;

  return [
    { x: 0,      y: mainY,  rot: 0,    scale: 0.90, opacity: 1.00 },  // main card
    { x: -stackX, y: stackY+stackX/4, rot: -rot, scale: 0.80, opacity: 1.00 },  // stack: 2nd
    { x: 0, y: stackY, rot: 0,    scale: 0.80, opacity: 1.00 },  // stack: 3rd
    { x: +stackX, y: stackY+stackX/4, rot: +rot, scale: 0.80, opacity: 1.00 },  // stack: 4th
  ];
}
let POSITIONS = computePositions();

const ANIM_DURATION = 550;
const FLIP_DURATION = 300;
const SWIPE_THRESHOLD = 40;
const EASE = 'cubic-bezier(0.4, 0, 0.15, 1)';

const stackEl = document.getElementById('card-stack');
const els = [];
// order[posIndex] = cardIndex
// order[0]=main, order[1]=stack 2nd, order[2]=stack 3rd, order[3]=stack 4th
let order = [0, 1, 2, 3];
let busy = false;

// ── Build card DOM ──
CARDS.forEach((c) => {
  const div = document.createElement('div');
  div.className = 'stack-card';
  div.dataset.cardId = c.id;
  div.innerHTML = `<img class="card-front" src="${c.img}" alt="Card ${c.id}" draggable="false"><img class="card-back" src="${CARD_BACK_IMG}" alt="Card back" draggable="false">`;
  stackEl.appendChild(div);
  els.push(div);
});

// ── Layout helpers ──
function setTransition(el, on) {
  el.style.transition = on
    ? `transform ${ANIM_DURATION}ms ${EASE}, opacity ${ANIM_DURATION}ms ${EASE}, box-shadow ${ANIM_DURATION}ms ease`
    : 'none';
}

function buildTransform(p) {
  return `translate(${p.x}%, ${p.y}%) rotate(${p.rot}deg) scale(${p.scale})`;
}

function applyPosition(cardIdx, posIdx, animate, zOverride) {
  const el = els[cardIdx];
  const p = POSITIONS[posIdx];
  setTransition(el, animate);
  el.style.transform = buildTransform(p);
  el.style.opacity = p.opacity;
  el.style.zIndex = zOverride ?? (CARDS.length - posIdx);
  el.dataset.pos = posIdx;
}

function layoutAll(animate) {
  order.forEach((ci, pi) => applyPosition(ci, pi, animate));
}

layoutAll(false);
els[order[0]].classList.add('card-revealed');

// Force a card to keep showing card-back via inline overrides
function lockBack(el) {
  const f = el.querySelector('.card-front');
  const b = el.querySelector('.card-back');
  f.style.transition = 'none';
  b.style.transition = 'none';
  f.style.opacity = '0';
  b.style.opacity = '1';
}

// Flip a card that is already at main position (data-pos="0") from card-back to card-front
function flipToFront(el, cb) {
  const half = FLIP_DURATION / 2;
  const base = el.style.transform;

  el.style.transition = `transform ${half}ms ease-in`;
  el.style.transform = `${base} rotateY(90deg)`;

  setTimeout(() => {
    const f = el.querySelector('.card-front');
    const b = el.querySelector('.card-back');
    f.style.transition = 'none';
    b.style.transition = 'none';
    f.style.opacity = '';
    b.style.opacity = '';
    el.classList.add('card-revealed');
    void el.offsetHeight;

    el.style.transition = `transform ${half}ms ease-out`;
    el.style.transform = base;

    setTimeout(() => {
      f.style.transition = '';
      b.style.transition = '';
      if (cb) cb();
    }, half);
  }, half);
}

// ── Swipe UP: main card flips to back → cards shift → new main flips to front ──
function next() {
  if (busy) return;
  busy = true;

  const departing = order[0];
  const el = els[departing];
  const half = FLIP_DURATION / 2;
  const baseTransform = buildTransform(POSITIONS[0]);

  // ── Phase 1a: rotate departing card to edge-on (0° → 90°) ──
  el.classList.remove('card-revealed');
  el.style.transition = `transform ${half}ms ease-in, box-shadow 350ms ease`;
  el.style.transform = `${baseTransform} rotateY(90deg)`;

  setTimeout(() => {
    const front = el.querySelector('.card-front');
    const back  = el.querySelector('.card-back');
    front.style.transition = 'none';
    back.style.transition  = 'none';
    el.dataset.pos = 'leaving';
    void el.offsetHeight;

    // ── Phase 1b: edge-on → card-back revealed (90° → 0°) ──
    el.style.transition = `transform ${half}ms ease-out`;
    el.style.transform = baseTransform;

    setTimeout(() => {
      front.style.transition = '';
      back.style.transition  = '';

      // ── Phase 2: shift all cards to new positions ──
      order.push(order.shift());

      const newMainEl = els[order[0]];
      lockBack(newMainEl);

      order.forEach((ci, pi) => {
        const z = (ci === departing) ? 0 : CARDS.length - pi;
        applyPosition(ci, pi, true, z);
      });

      setTimeout(() => {
        order.forEach((ci, pi) => {
          els[ci].style.zIndex = CARDS.length - pi;
        });

        // ── Phase 3: flip new main card to reveal front ──
        flipToFront(newMainEl, () => { busy = false; });
      }, ANIM_DURATION + 30);
    }, half);
  }, half);
}

// ── Swipe DOWN: main flips to back → cards shift → new main flips to front ──
function prev() {
  if (busy) return;
  busy = true;

  const arriving = order[order.length - 1];
  const arrivingEl = els[arriving];
  const oldMainEl = els[order[0]];
  const half = FLIP_DURATION / 2;
  const baseTransform = buildTransform(POSITIONS[0]);

  // ── Phase 1a: rotate old main card to edge-on (0° → 90°) ──
  oldMainEl.classList.remove('card-revealed');
  oldMainEl.style.transition = `transform ${half}ms ease-in, box-shadow 350ms ease`;
  oldMainEl.style.transform = `${baseTransform} rotateY(90deg)`;

  setTimeout(() => {
    const front = oldMainEl.querySelector('.card-front');
    const back  = oldMainEl.querySelector('.card-back');
    front.style.transition = 'none';
    back.style.transition  = 'none';
    oldMainEl.dataset.pos = 'leaving';
    void oldMainEl.offsetHeight;

    // ── Phase 1b: edge-on → card-back revealed (90° → 0°) ──
    oldMainEl.style.transition = `transform ${half}ms ease-out`;
    oldMainEl.style.transform = baseTransform;

    setTimeout(() => {
      front.style.transition = '';
      back.style.transition  = '';

      // ── Phase 2: shift all cards to new positions ──
      lockBack(arrivingEl);
      order.unshift(order.pop());

      order.forEach((ci, pi) => {
        const z = (ci === arriving) ? CARDS.length + 1 : CARDS.length - pi;
        applyPosition(ci, pi, true, z);
      });

      setTimeout(() => {
        order.forEach((ci, pi) => {
          els[ci].style.zIndex = CARDS.length - pi;
        });

        // ── Phase 3: flip new main card to reveal front ──
        flipToFront(arrivingEl, () => { busy = false; });
      }, ANIM_DURATION + 30);
    }, half);
  }, half);
}

// ── Pointer / touch interaction ──
let startY = 0;
let tracking = false;
let didSwipe = false;

function onDown(y) {
  if (busy) return;
  startY = y;
  tracking = true;
  didSwipe = false;
}

function onUp(y) {
  if (!tracking) return;
  tracking = false;
  const dy = startY - y;
  if (Math.abs(dy) > SWIPE_THRESHOLD) {
    didSwipe = true;
    // Swipe UP (dy > 0): stack-2nd becomes main, main goes to stack bottom
    // Swipe DOWN (dy < 0): reverse
    dy > 0 ? next() : prev();
  }
}

// Re-compute positions when breakpoint changes (e.g. window resize)
window.addEventListener('resize', () => {
  POSITIONS = computePositions();
  if (!busy) layoutAll(false);
});

document.addEventListener('touchstart', e => {
  if (e.touches.length === 1) onDown(e.touches[0].clientY);
}, { passive: true });

document.addEventListener('touchend', e => {
  if (e.changedTouches.length >= 1) onUp(e.changedTouches[0].clientY);
}, { passive: true });

document.addEventListener('mousedown', e => onDown(e.clientY));
document.addEventListener('mouseup', e => onUp(e.clientY));

// ── Click main card → enter detail page ──
els.forEach(el => {
  el.addEventListener('click', () => {
    if (didSwipe) return;
    if (parseInt(el.dataset.pos) !== 0) return;
    window.location.href = `card-viewer.html?card=${el.dataset.cardId}`;
  });
});
