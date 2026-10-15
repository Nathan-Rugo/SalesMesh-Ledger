// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BeamFlow } from './beam-flow';
import { Bento } from './bento';
import { LandingMotion } from './landing-motion';
import { MOTION_PENDING } from './motion-boot';
import { clock, HOLD_LEFT_S, isoDuration } from './sample-hold';

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

  it('leaves every landing element in its final state under reduced motion', () => {
    const { container } = render(
      <>
        <div data-stage="" />
        <BeamFlow />
        <Bento />
        <LandingMotion />
      </>
    );
    const chips = [...container.querySelectorAll<HTMLElement>('[data-chip]')];
    expect(chips).toHaveLength(4);
    for (const chip of chips) {
      expect(chip).toHaveAttribute('data-on');
      expect(chip).toHaveTextContent(chip.dataset.chip!);
    }
    expect(screen.getByText('01:59:42')).toHaveAttribute('datetime', 'PT1H59M42S');
    expect(container.querySelector('[data-stage]')).not.toHaveAttribute('data-inview');
    // Nothing hidden or offset by GSAP: tiles, SMS, refused retry and reason bars render as served.
    for (const el of container.querySelectorAll<HTMLElement>('[data-tile], [data-sms], [data-dup], [data-bar], [data-pulse]')) {
      expect(el.style.opacity).toBe('');
      expect(el.style.visibility).toBe('');
      expect(el.style.transform).toBe('');
    }
  });

  it('frosts the nav once the page scrolls, and stops listening on unmount', () => {
    const { container, unmount } = render(
      <>
        <header data-nav="" />
        <LandingMotion />
      </>
    );
    const nav = container.querySelector('[data-nav]')!;
    const scrollTo = (y: number) => {
      Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
      window.dispatchEvent(new Event('scroll'));
    };
    expect(nav).not.toHaveAttribute('data-scrolled');
    scrollTo(20);
    expect(nav).toHaveAttribute('data-scrolled');
    unmount();
    scrollTo(0);
    expect(nav).toHaveAttribute('data-scrolled');
  });
});

describe('sample hold formatting', () => {
  it('formats the countdown clock and its ISO duration', () => {
    expect(clock(HOLD_LEFT_S)).toBe('01:59:42');
    expect(clock(0)).toBe('00:00:00');
    expect(clock(59)).toBe('00:00:59');
    expect(isoDuration(HOLD_LEFT_S)).toBe('PT1H59M42S');
  });
});
