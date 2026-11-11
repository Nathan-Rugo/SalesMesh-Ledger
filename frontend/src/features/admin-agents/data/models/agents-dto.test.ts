import { describe, expect, it } from 'vitest';
import { agentView } from '@/test/fake-gateway';
import { toAgents } from './agents-dto';

describe('GET /api/v1/admin/agents validator', () => {
  it('maps agents, with and without a payout destination', () => {
    const a = toAgents({ agents: [agentView(), agentView({ agent_code: null, activated: false, payout: null })] })!;
    expect(a[0]).toEqual({ agentCode: 'AG042', name: 'Wanjiru Kamau', msisdn: '2547******78', activated: true, disabled: false, payout: { status: 'ACTIVE', msisdn: '2547******78' } });
    expect(a[1]).toMatchObject({ agentCode: null, activated: false, payout: null });
    expect(toAgents({ agents: [] })).toEqual([]);
  });

  it.each([
    ['not an object', null],
    ['agents not a list', { agents: {} }],
    ['activated not boolean', { agents: [agentView({ activated: 'yes' })] }],
    ['missing msisdn', { agents: [agentView({ msisdn: undefined })] }],
    ['bad payout', { agents: [agentView({ payout: { status: 'ACTIVE' } })] }],
  ])('malformed (%s) -> null, never a crash', (_n, body) => {
    expect(toAgents(body)).toBeNull();
  });
});
