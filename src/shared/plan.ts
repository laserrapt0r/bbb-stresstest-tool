import { t } from './i18n.js';
import type { Role, Scenario } from './scenario.js';

export interface Slot {
  id: number;
  meeting: number;
  /** Position inside the meeting, also the join order. */
  seat: number;
  /** Index of the load step that activates this seat. */
  step: number;
  role: Role;
}

export function usersPerStep(load: Scenario['load']): number[] {
  if (load.mode === 'fixed') return [load.usersPerMeeting];
  const steps: number[] = [];
  for (let n = load.startUsers; n <= load.maxUsers; n += load.stepUsers) steps.push(n);
  if (steps.at(-1) !== load.maxUsers) steps.push(load.maxUsers);
  return steps;
}

export function validatePlan(s: Scenario): string[] {
  const errors: string[] = [];
  const fixed = s.roles.reduce((sum, r) => sum + (r.count ?? 0), 0);
  const fills = s.roles.filter((r) => r.fill).length;
  const steps = usersPerStep(s.load);
  const first = steps[0] ?? 0;
  const last = steps.at(-1) ?? 0;

  if (fills > 1) errors.push(t('plan.oneFill'));
  if (first < fixed) errors.push(t('plan.firstStep', { first, fixed }));
  if (fills === 0 && last !== fixed) {
    errors.push(t('plan.noFill', { last, fixed }));
  }
  if (s.load.mode === 'steps' && s.load.startUsers > s.load.maxUsers) {
    errors.push(t('plan.startMax'));
  }
  return errors;
}

/** Fixed roles come first so that the presenter is the first moderator in the room. */
export function buildSlots(s: Scenario): Slot[] {
  const steps = usersPerStep(s.load);
  const maxUsers = steps.at(-1) ?? 0;
  const ordered = [...s.roles].sort((a, b) => {
    if (a.screenshare !== b.screenshare) return a.screenshare ? -1 : 1;
    if (a.moderator !== b.moderator) return a.moderator ? -1 : 1;
    return Number(a.fill ?? false) - Number(b.fill ?? false);
  });

  const seats: Role[] = [];
  for (const role of ordered) {
    const n = role.fill ? maxUsers - seats.length : (role.count ?? 0);
    for (let i = 0; i < n; i++) seats.push(role);
  }

  const slots: Slot[] = [];
  for (let meeting = 0; meeting < s.meetings; meeting++) {
    seats.forEach((role, seat) => {
      const step = steps.findIndex((users) => seat < users);
      slots.push({ id: slots.length, meeting, seat, step, role });
    });
  }
  return slots;
}

export function parseCpu(q: string): number {
  return q.endsWith('m') ? Number(q.slice(0, -1)) / 1000 : Number(q);
}

export function parseBytes(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T|m)?$/.exec(q);
  if (!m) throw new Error(t('plan.badQuantity', { value: q }));
  const factor: Record<string, number> = {
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1e3, M: 1e6, G: 1e9, T: 1e12, m: 1e-3,
  };
  return Number(m[1]) * (m[2] ? (factor[m[2]] ?? 1) : 1);
}

export function resourceNeed(s: Scenario) {
  const bots = (usersPerStep(s.load).at(-1) ?? 0) * s.meetings;
  return {
    bots,
    cpu: bots * parseCpu(s.bot.cpu),
    memoryBytes: bots * parseBytes(s.bot.memory),
  };
}
