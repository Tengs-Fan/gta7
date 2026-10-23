// The rifle scope overlay: a dark mask with a round sight and its reticle, shown while the camera looks through a scope
// (CameraController.scoped). The HUD crosshair is hidden under it.

import './scope.css';

export class ScopeOverlay {
  readonly el: HTMLDivElement;
  private shown = false;

  constructor(private readonly root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'scope-overlay hidden';
    this.el.dataset.el = 'scope';
    this.el.innerHTML = '<div class="scope-lens"><i class="h"></i><i class="v"></i><i class="dot"></i></div>';
    root.appendChild(this.el);
  }

  update(scoped: boolean): void {
    if (scoped === this.shown) return;
    this.shown = scoped;
    this.el.classList.toggle('hidden', !scoped);
    this.root.classList.toggle('scoped', scoped);
  }

  get visible(): boolean {
    return this.shown;
  }
}
