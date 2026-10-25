/**
 * Characters dissolve right in front of the camera, by depth along the view (m): nothing nearer than LENS_FADE_GONE is
 * drawn, and they are whole again from LENS_FADE_FULL. The near plane (0.3 m) then never cuts one open into a hollow
 * shell, whether a wall has pulled the camera in to the player's head or a passer-by brushes the lens.
 */
export const LENS_FADE_GONE = 0.45;
export const LENS_FADE_FULL = 0.9;
