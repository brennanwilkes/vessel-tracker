export function mount(root) {
  root.innerHTML = `
    <div class="camera-page">
      <div class="camera-icon-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
      </div>
      <div class="camera-page-title">AR Camera</div>
      <div class="camera-page-sub">
        Point your camera at a vessel and see its AIS identity overlaid in real time.
      </div>
      <div class="milestone-tag">Milestone 3</div>
    </div>
  `;
}

export function unmount() {}
