/**
 * Keeps the page at the newest caption, on the phone page and on /transcript.
 *
 * The page is either following or the reader has left to read something further up. That is
 * stored, not worked out from the scroll position, so a tall caption, or a caption arriving
 * in the middle of a scroll, can't stop it. Only the page moving up without us moving it
 * means the reader left. Moving back down near the bottom, or resume(), starts following again.
 *
 * ws-server.js inlines this file into both pages rather than serving it, because the
 * audience subdomain's nginx config sends every path to /audience.
 */
window.createFollowScroll = function ({ watch = [], isHeld = () => false, onChange = () => {} }) {
  const RESUME_PX = 70;         // this close to the bottom counts as being back
  const UP_TOLERANCE_PX = 12;   // a tap can nudge the page; that isn't leaving
  const LAYOUT_GRACE_MS = 200;  // the page can move up by itself just after a layout shift
  const SETTLE_MS = 160;        // no scrolling for this long: the flick has stopped coasting
  const EASE = 0.2;             // share of the remaining distance covered per frame

  const page = document.scrollingElement || document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let following = true;
  let lastTop = page.scrollTop;
  let lastHeight = page.scrollHeight;
  let layoutShiftAt = -Infinity;
  let touching = false;
  let settleTimer = null;
  let frame = null;

  const maxTop = () => Math.max(0, page.scrollHeight - window.innerHeight);
  const gap = () => maxTop() - page.scrollTop;
  const blocked = () => touching || settleTimer !== null || isHeld();

  function setFollowing(next) {
    if (next === following) return;
    following = next;
    onChange(following);
  }

  function layoutShifted() {
    layoutShiftAt = performance.now();
  }

  function noteHeight() {
    const height = page.scrollHeight;
    if (height < lastHeight) layoutShifted();
    lastHeight = height;
  }

  // Moves toward the bottom, re-reading it each frame so a caption arriving mid-scroll is
  // included. Long distances jump: nobody needs to watch minutes of captions go past.
  function step() {
    frame = null;
    if (!following || blocked()) return;
    const remaining = gap();
    if (remaining <= 1) return;

    const before = page.scrollTop;
    const jump = document.hidden || reducedMotion.matches || remaining > window.innerHeight;
    page.scrollTop = jump ? maxTop() : before + Math.ceil(remaining * EASE);
    lastTop = page.scrollTop;

    if (lastTop !== before && gap() > 1) schedule();
  }

  function schedule() {
    if (frame === null) frame = requestAnimationFrame(step);
  }

  function pin() {
    noteHeight();
    if (!following || blocked()) return;
    if (document.hidden) step(); // animation frames don't run in a hidden tab
    else schedule();
  }

  function resume() {
    clearTimeout(settleTimer);
    settleTimer = null;
    noteHeight();
    setFollowing(true);
    schedule();
  }

  function settleSoon() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      pin();
    }, SETTLE_MS);
  }

  window.addEventListener('scroll', () => {
    noteHeight();
    if (settleTimer !== null) settleSoon();

    const top = page.scrollTop;
    if (top > maxTop() + 1) return; // iOS bounce past the end; springing back isn't leaving

    if (performance.now() - layoutShiftAt < LAYOUT_GRACE_MS) {
      lastTop = top;
    } else if (top < lastTop - UP_TOLERANCE_PX) {
      lastTop = top;
      setFollowing(false);
    } else if (top > lastTop) {
      lastTop = top;
      if (!following && gap() <= RESUME_PX) setFollowing(true);
    }
  }, { passive: true });

  // While a finger is down or a flick is coasting, leave the page alone.
  window.addEventListener('touchstart', () => {
    touching = true;
    clearTimeout(settleTimer);
    settleTimer = null;
  }, { passive: true });

  function touchEnded(event) {
    if (event.touches.length > 0) return;
    touching = false;
    settleSoon();
  }
  window.addEventListener('touchend', touchEnded, { passive: true });
  window.addEventListener('touchcancel', touchEnded, { passive: true });

  // Toolbars hiding and phones rotating change the page size without the reader scrolling.
  window.addEventListener('resize', () => {
    layoutShifted();
    pin();
  }, { passive: true });

  document.addEventListener('visibilitychange', pin);
  window.addEventListener('pageshow', pin);

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(pin);
    watch.forEach(element => observer.observe(element));
  }

  // The pages always open at the newest caption; a restored position would look like leaving.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  return { pin, resume, layoutShifted, isFollowing: () => following };
};
