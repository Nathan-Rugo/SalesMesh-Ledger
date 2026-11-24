'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import { MOTION_PENDING } from './motion-boot';
import { clock, HOLD_LEFT_S, HOLD_TOTAL_S, isoDuration } from './sample-hold';

gsap.registerPlugin(useGSAP, ScrollTrigger);

/** Hero: the printer feeds the slip out of its mouth, then the seal is pressed onto it. */
function heroTimeline(shown: boolean) {
  const receipt = document.querySelector<HTMLElement>('[data-hero-receipt]');
  if (!receipt) return () => {};
  const stamp = receipt.querySelector('[data-stamp]');
  const ink = receipt.querySelector('[data-stamp-ink]');
  const led = document.querySelector('[data-printer-led]');
  const printer = document.querySelector('[data-printer]');
  const FEED_S = 1.6;
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  tl.addLabel('feed', 0)
    // Thermal printers feed at a constant rate: linear, from fully inside the mouth to fully out.
    .fromTo(receipt, { yPercent: -100 }, { yPercent: 0, duration: FEED_S, ease: 'none' }, 'feed');
  // While it feeds the status light flickers and the body hums; both end where they started.
  if (led) tl.fromTo(led, { opacity: 0.25 }, { opacity: 1, duration: 0.1, repeat: 15, yoyo: true, ease: 'none' }, 'feed');
  if (printer) tl.fromTo(printer, { y: 0 }, { y: 0.7, duration: 0.05, repeat: 31, yoyo: true, ease: 'none' }, 'feed');

  tl.addLabel('stamp', `feed+=${FEED_S + 0.3}`);
  if (stamp) {
    // Lifted, tilted and soft (out of focus) above the paper; drops fast, squashes on contact, settles.
    tl.fromTo(
      stamp,
      { autoAlpha: 0, scale: 1.8, y: -40, rotate: -16, filter: 'blur(3px)' },
      { autoAlpha: 1, scale: 0.9, y: 0, rotate: -3, filter: 'blur(0px)', duration: 0.3, ease: 'power3.in' },
      'stamp'
    ).to(stamp, { scale: 1, rotate: 0, duration: 0.4, ease: 'back.out(3)', clearProps: 'filter' }, 'stamp+=0.3');
    // The impact: the paper dips under the press and a ring of ink spreads once.
    tl.to(receipt, { y: 3, duration: 0.07, yoyo: true, repeat: 1, ease: 'power1.inOut' }, 'stamp+=0.3');
    if (ink) tl.fromTo(ink, { autoAlpha: 0.6, scale: 0.92 }, { autoAlpha: 0, scale: 1.35, duration: 0.7, ease: 'power2.out' }, 'stamp+=0.3');
  }
  // The two annotations slide in from either side once the slip is stamped.
  document.querySelectorAll<HTMLElement>('[data-hero-chip]').forEach((chip, i) => {
    tl.fromTo(chip, { autoAlpha: 0, x: i === 0 ? -18 : 18 }, { autoAlpha: 1, x: 0, duration: 0.55 }, `stamp+=${0.5 + i * 0.12}`);
  });
  // Prints once the printer sits in the upper part of the screen, so the feed is seen from the start.
  replayInView(tl, printer, 'top 60%', 'top 8%', shown);
  return () => tl.progress(1);
}

/** Run `play` once, the first time `el` scrolls into view. Every run is finite (<= 5 s, WCAG 2.2.2). */
function onFirstView(el: Element | null, play: () => void, start = 'top 85%') {
  if (el) ScrollTrigger.create({ trigger: el, start, once: true, onEnter: play });
}

/**
 * Plays `tl` each time `el` comes well into view, from below (`start`) or from above (`end`), and
 * rewinds it only once `el` is fully off screen, so a replay never visibly jumps back to its start.
 * Each run stays finite (WCAG 2.2.2). `shown`: start in the finished state (content already visible).
 */
function replayInView(tl: gsap.core.Timeline, el: Element | null, start = 'bottom 92%', end = 'top 8%', shown = false) {
  if (!el) return;
  if (shown) tl.progress(1).pause();
  else tl.pause(0);
  ScrollTrigger.create({ trigger: el, start, end, onEnter: () => tl.restart(), onEnterBack: () => tl.restart() });
  ScrollTrigger.create({ trigger: el, start: 'top bottom', end: 'bottom top', onLeave: () => tl.pause(0), onLeaveBack: () => tl.pause(0) });
}

/** "How a shilling travels": one pass (~4 s) of a pulse along each beam, lighting the next chip; ends with every chip lit. */
function beamFlow(wide: boolean) {
  const flow = document.querySelector<HTMLElement>('[data-flow]');
  if (!flow) return () => {};
  const chips = [...flow.querySelectorAll<HTMLElement>('[data-chip]')];
  const pulses = [...flow.querySelectorAll<HTMLElement>('[data-pulse]')];
  const light = (chip: HTMLElement, on: boolean, pop = false) => {
    chip.toggleAttribute('data-on', on);
    const icon = chip.closest('li')?.querySelector('[data-hop-icon]');
    if (pop && icon) gsap.fromTo(icon, { scale: 0.82 }, { scale: 1, duration: 0.5, ease: 'back.out(3)' });
    const label = chip.querySelector('[data-chip-label]');
    if (label) label.textContent = on ? chip.dataset.chip! : 'Waiting';
  };
  const reset = () => chips.forEach((c, i) => light(c, i === 0));
  const axis = wide ? 'xPercent' : 'yPercent';
  const tl = gsap.timeline({ paused: true, onStart: reset });
  pulses.forEach((p, i) => {
    tl.fromTo(p, { [axis]: -100, autoAlpha: 1 }, { [axis]: 100, duration: 0.9, ease: 'power1.inOut' }, '+=0.45')
      .set(p, { autoAlpha: 0 })
      .call(() => light(chips[i + 1]!, true, true));
  });
  replayInView(tl, flow, 'top 70%', 'top 10%');
  return () => chips.forEach((c) => light(c, true));
}

/** Bento: each tile rises in once, then plays its mini-UI; the hold countdown ticks its last 5 s once, ending on the served value. */
function bento() {
  document.querySelectorAll<HTMLElement>('[data-tile]').forEach((tile) => {
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    replayInView(tl, tile, 'top 85%', 'top 10%');
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
    const sms = tile.querySelector<HTMLElement>('[data-sms]');
    const phone = tile.querySelector<HTMLElement>('[data-phone]');
    if (!sms) return;
    // The notification has its own trigger on the phone, so it plays only once the whole phone is
    // on screen: hidden now, then a buzz and the banner dropping out of the camera island.
    gsap.set(sms, { autoAlpha: 0 });
    const ping = gsap.timeline({ delay: 0.35 });
    if (phone) ping.fromTo(phone, { rotate: 0 }, { rotate: 1.2, duration: 0.05, repeat: 7, yoyo: true, ease: 'none' });
    ping.fromTo(
      sms,
      { y: -70, scale: 0.86, autoAlpha: 0, transformOrigin: '50% 0%' },
      { y: 0, scale: 1, autoAlpha: 1, duration: 0.7, ease: 'back.out(1.5)' },
      phone ? '<0.1' : 0
    );
    replayInView(ping, phone ?? sms, 'center 70%', 'center 30%');
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

/** Section headings rise in once as they reach the lower part of the screen. */
function headings() {
  const els = gsap.utils.toArray<HTMLElement>('main h2');
  gsap.set(els, { autoAlpha: 0, y: 24 });
  ScrollTrigger.batch(els, {
    start: 'top 88%',
    once: true,
    onEnter: (batch) => gsap.to(batch, { autoAlpha: 1, y: 0, duration: 0.8, ease: 'power3.out', stagger: 0.1 }),
  });
}

/**
 * Desktop only: the element leans toward the pointer in 3D while it is over `area`, and levels out
 * when it leaves. quickTo reuses one tween per axis, so pointermove never piles up tweens.
 */
function tilt(target: HTMLElement | null, area: HTMLElement | null, maxDeg: number) {
  if (!target || !area) return () => {};
  gsap.set(target, { transformPerspective: 900, transformOrigin: '50% 50%' });
  const rx = gsap.quickTo(target, 'rotationX', { duration: 0.6, ease: 'power3' });
  const ry = gsap.quickTo(target, 'rotationY', { duration: 0.6, ease: 'power3' });
  const move = (e: PointerEvent) => {
    const r = area.getBoundingClientRect();
    ry(((e.clientX - r.left) / r.width - 0.5) * 2 * maxDeg);
    rx(-((e.clientY - r.top) / r.height - 0.5) * 2 * maxDeg);
  };
  const leave = () => {
    rx(0);
    ry(0);
  };
  area.addEventListener('pointermove', move);
  area.addEventListener('pointerleave', leave);
  return () => {
    area.removeEventListener('pointermove', move);
    area.removeEventListener('pointerleave', leave);
    gsap.set(target, { rotationX: 0, rotationY: 0 });
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
      // Slightly softer than the default glide, and in-page links (#how, #security) scroll through Lenis
      // so they ease too, stopping clear of the sticky nav.
      const lenis = new Lenis({ lerp: 0.085, smoothWheel: true, anchors: { offset: -72 } });
      lenis.on('scroll', ScrollTrigger.update);
      const tick = (time: number) => lenis.raf(time * 1000);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
      const undoHero = heroTimeline(!printHero);
      const stage = document.querySelector('[data-stage]');
      // The border beam turns once (CSS, 5 s) the first time the stage is on screen.
      onFirstView(stage, () => stage?.setAttribute('data-inview', ''), 'top bottom');
      const undoBento = bento();
      headings();
      return () => {
        gsap.ticker.remove(tick);
        gsap.ticker.lagSmoothing(500, 33);
        lenis.destroy();
        undoHero();
        undoBento();
        stage?.removeAttribute('data-inview');
      };
    });
    mm.add('(prefers-reduced-motion: no-preference) and (hover: hover) and (pointer: fine)', () => {
      const undoHeroTilt = tilt(document.querySelector('[data-tilt="hero"]'), document.querySelector('[data-stage]'), 5);
      const undoPhoneTilt = tilt(document.querySelector('[data-tilt="phone"]'), document.querySelector('[data-tilt="phone"]')?.closest('[data-tile]') ?? null, 8);
      return () => {
        undoHeroTilt();
        undoPhoneTilt();
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
