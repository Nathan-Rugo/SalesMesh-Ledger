// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LandingMotion } from './landing-motion';
import { MOTION_PENDING } from './motion-boot';

// jsdom has no matchMedia and gsap reads it at import, so stub before the imports run.
// Reduced motion: no GSAP work, only the class hand-off is under test.
vi.hoisted(() => {
  window.matchMedia = ((q: string) => ({
    matches: q.includes(': reduce'),
    media: q,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

describe('LandingMotion', () => {
  it('clears the boot class so the hero slip is never left hidden', () => {
    document.documentElement.classList.add(MOTION_PENDING);
    render(<LandingMotion />);
    expect(document.documentElement.classList.contains(MOTION_PENDING)).toBe(false);
  });
});
