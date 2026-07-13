// ---------- Site stats: visit counter + like/dislike ----------
// Backed by CounterAPI's public v1 endpoint (https://counterapi.dev) — a
// free, keyless, CORS-enabled counter service. No account/backend needed:
// each named counter under our namespace just lives on their server and we
// bump it with a plain GET request. Network failures are swallowed so a
// slow/unreachable counter API never breaks the battlefield itself.
(function () {
  const NAMESPACE = 'btcbattle-kmd83';
  const API = `https://api.counterapi.dev/v1/${NAMESPACE}`;
  const VOTE_KEY = 'btcbattle_vote'; // 'like' | 'dislike' | absent, persisted in localStorage
  const VISITED_KEY = 'btcbattle_visited_session'; // sessionStorage guard so a refresh mid-session doesn't double-count

  const visitEl = document.getElementById('visitCount');
  const likeEl = document.getElementById('likeCount');
  const dislikeEl = document.getElementById('dislikeCount');
  const likeBtn = document.getElementById('likeBtn');
  const dislikeBtn = document.getElementById('dislikeBtn');
  if (!visitEl || !likeBtn || !dislikeBtn) return; // markup missing — nothing to wire up

  function setText(el, n) {
    if (el) el.textContent = Number.isFinite(n) ? String(n) : '--';
  }

  async function hit(name, action) {
    // action: 'up' | 'down' | '' (plain read, no mutation)
    const res = await fetch(action ? `${API}/${name}/${action}` : `${API}/${name}/`);
    if (!res.ok) throw new Error(`counter API ${res.status}`);
    const data = await res.json();
    return typeof data.count === 'number' ? data.count : null;
  }

  function applyVoteUI(vote) {
    likeBtn.classList.toggle('active', vote === 'like');
    dislikeBtn.classList.toggle('active', vote === 'dislike');
  }

  async function initVisits() {
    try {
      const alreadyThisSession = sessionStorage.getItem(VISITED_KEY);
      const count = alreadyThisSession ? await hit('visits', '') : await hit('visits', 'up');
      if (!alreadyThisSession) sessionStorage.setItem(VISITED_KEY, '1');
      setText(visitEl, count);
    } catch (e) {
      setText(visitEl, null);
    }
  }

  async function initVotes() {
    try {
      const [likes, dislikes] = await Promise.all([hit('likes', ''), hit('dislikes', '')]);
      setText(likeEl, likes);
      setText(dislikeEl, dislikes);
    } catch (e) {
      setText(likeEl, null);
      setText(dislikeEl, null);
    }
    applyVoteUI(localStorage.getItem(VOTE_KEY));
  }

  async function vote(target) {
    const current = localStorage.getItem(VOTE_KEY);
    if (current === target) return; // already voted this way — nothing to do

    likeBtn.disabled = true;
    dislikeBtn.disabled = true;
    try {
      // switching an existing opposite vote pulls it back down before adding the new one
      if (current === 'like') {
        const n = await hit('likes', 'down');
        setText(likeEl, n);
      } else if (current === 'dislike') {
        const n = await hit('dislikes', 'down');
        setText(dislikeEl, n);
      }
      if (target === 'like') {
        const n = await hit('likes', 'up');
        setText(likeEl, n);
      } else {
        const n = await hit('dislikes', 'up');
        setText(dislikeEl, n);
      }
      localStorage.setItem(VOTE_KEY, target);
      applyVoteUI(target);
    } catch (e) {
      // network hiccup — leave counts/vote state as they were
    } finally {
      likeBtn.disabled = false;
      dislikeBtn.disabled = false;
    }
  }

  likeBtn.addEventListener('click', () => vote('like'));
  dislikeBtn.addEventListener('click', () => vote('dislike'));

  initVisits();
  initVotes();
})();
