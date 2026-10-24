// The "LOADING SAN AZURA" screen with a determinate bar that follows the asset preload.

export function loadingMarkup(): string {
  return '<div class="loading"><div>LOADING SAN AZURA<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-progress="0"><i style="width:0%;display:block;height:100%;background:#ff4fa3"></i></div></div></div>';
}

/** Moves the bar to `fraction` (0..1). Does nothing once the loading screen is gone. */
export function setLoadingProgress(ui: ParentNode, fraction: number): void {
  const bar = ui.querySelector<HTMLElement>('.loading .bar');
  const fill = bar?.querySelector<HTMLElement>('i');
  if (!bar || !fill) return;
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10;
  fill.style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.dataset.progress = String(pct);
}
