/** Touch-first device (phone / tablet): no fine pointer to look with, so we show touch controls. */
export const isTouch = (): boolean =>
  typeof matchMedia !== 'undefined' && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches));
