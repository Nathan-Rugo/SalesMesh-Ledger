'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import { moneyParts } from '@/shared/domain/money';
import { MOTION_PENDING } from './motion-boot';
import { clock, HOLD_LEFT_S, HOLD_TOTAL_S, isoDuration } from './sample-hold';

gsap.registerPlugin(useGSAP, ScrollTrigger);

const shillings = (n: number) => moneyParts(Math.round(n) * 100).integer;

/** Hero: the slip prints out of the slot, lines settle, the amount ticks up, the seal stamps once. */
function heroTimeline() {
  const receipt = document.querySelector<HTMLElement>('[data-hero-receipt]');
  if (!receipt) return () => {};
  const counter = receipt.querySelector<HTMLElement>('[data-count]');
  const target = Number(counter?.dataset.count ?? 0);
  const n = { v: 0 };
  const tl = gsap.timeline({ delay: 0.15, defaults: { ease: 'power3.out' } });
  tl.fromTo(
    receipt,
    { clipPath: 'inset(0% -40px 100% -40px)', y: -28 },
    { clipPath: 'inset(0% -40px -40px -40px)', y: 0, duration: 1, ease: 'power2.out', clearProps: 'clipPath' }
  )
    // Explicit end values: the slip is still visibility:hidden (boot class) when this is built, so
    // a .from() would read that back as the end state.
    .fromTo(receipt.querySelectorAll('[data-hero-line]'), { opacity: 0, y: 8 }, { opacity: 1, y: 0, stagger: 0.08, duration: 0.45 }, '-=0.6')
    .to(
      n,
      {
        v: target,
        duration: 1.1,
        ease: 'power2.out',
        onStart: () => counter && (counter.textContent = shillings(0)),
        onUpdate: () => counter && (counter.textContent = shillings(n.v)),
      },
      '<'
    )
    .fromTo(
      receipt.querySelector('[data-stamp]'),
      { scale: 2.3, rotate: -14, autoAlpha: 0 },
      { scale: 1, rotate: 0, autoAlpha: 1, duration: 0.45, ease: 'back.out(2.4)' },
      '-=0.15'
    )
    .to(receipt, { y: 3, duration: 0.07, yoyo: true, repeat: 1, ease: 'power1.inOut' }, '-=0.3');
  // Revert leaves text alone, so put the real amount back.
  return () => counter && (counter.textContent = shillings(target));
}

/** Run `play` once, the first time `el` scrolls into view. Every run is finite (<= 5 s, WCAG 2.2.2). */
function onFirstView(el: Element | null, play: () => void, start = 'top 85%') {
  if (el) ScrollTrigger.create({ trigger: el, start, once: true, onEnter: play });
}

/** "How a shilling travels": one pass (~4 s) of a pulse along each beam, lighting the next chip; ends with every chip lit. */
function beamFlow(wide: boolean) {
  const flow = document.querySelector<HTMLElement>('[data-flow]');
  if (!flow) return () => {};
  const chips = [...flow.querySelectorAll<HTMLElement>('[data-chip]')];
  const pulses = [...flow.querySelectorAll<HTMLElement>('[data-pulse]')];
  const light = (chip: HTMLElement, on: boolean) => {
    chip.toggleAttribute('data-on', on);
    const label = chip.querySelector('[data-chip-label]');
    if (label) label.textContent = on ? chip.dataset.chip! : 'Waiting';
  };
  const reset = () => chips.forEach((c, i) => light(c, i === 0));
  const axis = wide ? 'xPercent' : 'yPercent';
  const tl = gsap.timeline({ paused: true, onStart: reset });
  pulses.forEach((p, i) => {
    tl.fromTo(p, { [axis]: -100, autoAlpha: 1 }, { [axis]: 100, duration: 0.9, ease: 'power1.inOut' }, '+=0.45')
      .set(p, { autoAlpha: 0 })
      .call(() => light(chips[i + 1]!, true));
  });
  onFirstView(flow, () => tl.play());
  return () => chips.forEach((c) => light(c, true));
}

/** Bento: each tile rises in once, then plays its mini-UI; the hold countdown ticks its last 5 s once, ending on the served value. */
function bento() {
  document.querySelectorAll<HTMLElement>('[data-tile]').forEach((tile) => {
    const tl = gsap.timeline({ scrollTrigger: { trigger: tile, start: 'top 88%', once: true }, defaults: { ease: 'power3.out' } });
    tl.fromTo(tile, { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.6 });
    const rows = tile.querySelectorAll('[data-ledger-row]');
    if (rows.length) tl.fromTo(rows, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, stagger: 0.12, duration: 0.4 }, '-=0.2');
    const dup = tile.querySelector('[data-dup]');
    if (dup)
      tl.fromTo(dup, { autoAlpha: 0, y: -10 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: 'back.out(2)' }, '+=0.3').to(dup, {
        x: -4,
        duration: 0.06,
        yoyo: true,
        repeat: 3,
        ease: 'power1.inOut',
      });
    const bars = tile.querySelectorAll('[data-bar]');
    if (bars.length) tl.fromTo(bars, { scaleX: 0 }, { scaleX: 1, stagger: 0.1, duration: 0.7 }, '-=0.2');
    const sms = tile.querySelector('[data-sms]');
    if (sms) tl.fromTo(sms, { yPercent: -140, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.6, ease: 'back.out(1.6)' }, '+=0.5');
  });

  const time = document.querySelector<HTMLTimeElement>('[data-countdown]');
  const bar = document.querySelector<HTMLElement>('[data-countdown-bar]');
  if (!time || !bar) return () => {};
  const show = (s: number) => {
    time.textContent = clock(s);
    time.dateTime = isoDuration(s);
    bar.style.transform = `scaleX(${1 - s / HOLD_TOTAL_S})`;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  onFirstView(time, () => {
    let left = HOLD_LEFT_S + 5;
    show(left);
    timer = setInterval(() => {
      show(--left);
      if (left <= HOLD_LEFT_S) clearInterval(timer);
    }, 1000);
  });
  return () => {
    clearInterval(timer);
    show(HOLD_LEFT_S);
  };
}

/**
 * Landing-only motion (GSAP + Lenis). Everything is server-rendered in its final state; this only
 * animates toward it, and only under `prefers-reduced-motion: no-preference`.
 */
export function LandingMotion() {
  useGSAP(() => {
    // Nav frost is state, not motion: on for everyone once the page scrolls.
    const nav = document.querySelector('[data-nav]');
    const onScroll = () => nav?.toggleAttribute('data-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    // Print the hero only while the boot script still hides it; if hydration came after its 2 s
    // give-up, the slip is already on screen and re-printing it would flash.
    const printHero = document.documentElement.classList.contains(MOTION_PENDING);
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const lenis = new Lenis();
      lenis.on('scroll', ScrollTrigger.update);
      const tick = (time: number) => lenis.raf(time * 1000);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
      const undoHero = printHero ? heroTimeline() : () => {};
      const stage = document.querySelector('[data-stage]');
      // The border beam turns once (CSS, 5 s) the first time the stage is on screen.
      onFirstView(stage, () => stage?.setAttribute('data-inview', ''), 'top bottom');
      const undoBento = bento();
      return () => {
        gsap.ticker.remove(tick);
        gsap.ticker.lagSmoothing(500, 33);
        lenis.destroy();
        undoHero();
        undoBento();
        stage?.removeAttribute('data-inview');
      };
    });
    // The beams run down on phones and across on desktop, so they rebuild when that changes.
    mm.add({ motion: '(prefers-reduced-motion: no-preference)', wide: '(min-width: 1024px)' }, (ctx) => {
      const { motion, wide } = ctx.conditions as { motion: boolean; wide: boolean };
      return motion ? beamFlow(wide) : undefined;
    });
    // First frames are set synchronously above, so the slip can be shown without a flash.
    document.documentElement.classList.remove(MOTION_PENDING);
    return () => {
      window.removeEventListener('scroll', onScroll);
      mm.revert();
    };
  });
  return null;
}
