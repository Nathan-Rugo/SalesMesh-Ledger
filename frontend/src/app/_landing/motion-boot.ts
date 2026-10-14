/** Class set before first paint while the hero slip waits for its first animation frame (CSS in theme.css). */
export const MOTION_PENDING = 'sm-motion';

/** Inline boot script: hide the hero slip only when motion will run, and give up after 2 s (JS failed). */
export const MOTION_BOOT = `(function(){var d=document.documentElement;if(!matchMedia('(prefers-reduced-motion: reduce)').matches){d.classList.add('${MOTION_PENDING}');setTimeout(function(){d.classList.remove('${MOTION_PENDING}')},2000)}})()`;
