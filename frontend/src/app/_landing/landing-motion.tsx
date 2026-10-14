'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import { moneyParts } from '@/shared/domain/money';
import { MOTION_PENDING } from './motion-boot';

gsap.registerPlugin(useGSAP, ScrollTrigger);

const shillings = (n: number) => moneyParts(Math.round(n) * 100).integer;

/** Hero: the slip prints out of the slot, lines settle, the amount counts up, the seal stamps once. */
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

/** "How a shilling travels": scroll rides a coin down the payment rail, pausing at Held; the Cleared seal stamps on arrival. */
function railScrub() {
  const rail = document.querySelector<HTMLElement>('[data-rail]');
  const coin = rail?.querySelector<HTMLElement>('[data-coin]');
  if (!rail || !coin) return () => {};
  const steps = [...rail.querySelectorAll<HTMLElement>('[data-step]')];
  const markers = steps.map((li) => li.querySelector<HTMLElement>('[data-marker]')!);
  // Marker offset inside the rail (functions, so ScrollTrigger re-measures on resize).
  const yOf = (i: number) => () => markers[i]!.getBoundingClientRect().top - rail.getBoundingClientRect().top;
  const reach = () => {
    const y = Number(gsap.getProperty(coin, 'y'));
    steps.forEach((el, i) => el.toggleAttribute('data-reached', y >= yOf(i)() - 1));
  };
  gsap.set(coin, { autoAlpha: 1, y: yOf(0) });
  reach();
  gsap
    .timeline({
      defaults: { ease: 'none', onUpdate: reach },
      scrollTrigger: { trigger: rail, start: 'top 65%', end: 'bottom 70%', scrub: 0.6, invalidateOnRefresh: true },
    })
    .to(coin, { y: yOf(1), duration: 1 })
    .to(coin, { y: yOf(2), duration: 1 }, '+=0.35') // the hold at Held
    .fromTo(
      rail.querySelector('[data-rail-seal]'),
      { scale: 2, rotate: -12, autoAlpha: 0 },
      { scale: 1, rotate: 0, autoAlpha: 1, duration: 0.35, ease: 'back.out(2.2)' }
    );
  return () => steps.forEach((el) => el.setAttribute('data-reached', ''));
}

/**
 * Landing-only motion (GSAP + Lenis). Everything is server-rendered in its final state; this only
 * animates toward it, and only under `prefers-reduced-motion: no-preference`.
 */
export function LandingMotion() {
  useGSAP(() => {
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
      const undoRail = railScrub();
      return () => {
        gsap.ticker.remove(tick);
        gsap.ticker.lagSmoothing(500, 33);
        lenis.destroy();
        undoHero();
        undoRail();
      };
    });
    // First frames are set synchronously above, so the slip can be shown without a flash.
    document.documentElement.classList.remove(MOTION_PENDING);
    return () => mm.revert();
  });
  return null;
}
