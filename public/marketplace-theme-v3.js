(() => {
  const header = document.querySelector('.header');

  if (!header) return;

  let ticking = false;

  function updateHeader() {
    const compact =
      window.innerWidth <= 640 &&
      window.scrollY > 140;

    header.classList.toggle(
      'is-compact',
      compact
    );

    ticking = false;
  }

  function requestUpdate() {
    if (ticking) return;

    ticking = true;

    window.requestAnimationFrame(
      updateHeader
    );
  }

  window.addEventListener(
    'scroll',
    requestUpdate,
    { passive:true }
  );

  window.addEventListener(
    'resize',
    requestUpdate
  );

  updateHeader();
})();
