import type { DirectoryAgent } from '../../domain/entities/agent';

// Validator for GET /api/v1/admin/agents (admin.controller.ts): null on any malformed field, never a crash.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function toAgent(v: unknown): DirectoryAgent | null {
  if (!isObj(v) || !(v.agent_code === null || isStr(v.agent_code)) || !isStr(v.full_name) || !isStr(v.msisdn)) return null;
  if (typeof v.activated !== 'boolean' || typeof v.disabled !== 'boolean') return null;
  let payout: DirectoryAgent['payout'] = null;
  if (v.payout !== null) {
    if (!isObj(v.payout) || !isStr(v.payout.status) || !isStr(v.payout.msisdn)) return null;
    payout = { status: v.payout.status, msisdn: v.payout.msisdn };
  }
  return { agentCode: v.agent_code, name: v.full_name, msisdn: v.msisdn, activated: v.activated, disabled: v.disabled, payout };
}

export function toAgents(body: unknown): DirectoryAgent[] | null {
  if (!isObj(body) || !Array.isArray(body.agents)) return null;
  const out: DirectoryAgent[] = [];
  for (const a of body.agents) {
    const m = toAgent(a);
    if (!m) return null;
    out.push(m);
  }
  return out;
}
