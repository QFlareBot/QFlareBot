import type { GroupApi, GroupInfo, GroupMember, JoinApprovalStrategy, JoinRequest, MuteOp } from '@qqbot/sdk'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface Caller {
  call<T>(method: HttpMethod, path: string, body?: unknown, what?: string): Promise<T>
}

function toRfc3339(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

/** 群管理接口的类型化包装；字段名与官方文档一致，机器人需为群管理员 */
export function createGroupApi(client: Caller): GroupApi {
  const base = (g: string) => `/v2/groups/${g}`
  return {
    info: (g) => client.call<GroupInfo>('GET', `${base(g)}/info`, undefined, '获取群信息'),
    botState: (g) => client.call('GET', `${base(g)}/bot_state`, undefined, '获取机器人群内状态'),

    async joinStrategies(cursor = '') {
      const data = await client.call<{ strategies?: JoinApprovalStrategy[]; next_cursor?: string }>(
        'GET',
        `/v2/groups/join_approval_strategy${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        undefined,
        '查询入群自动审批策略',
      )
      return { strategies: data.strategies ?? [], nextCursor: data.next_cursor ?? '' }
    },

    async setJoinStrategy(g, strategy) {
      await client.call(
        'PUT',
        '/v2/groups/join_approval_strategy',
        { group_openid: g, ...strategy },
        '设置入群自动审批策略',
      )
    },

    async members(g, cursor = '') {
      const data = await client.call<{ members?: GroupMember[]; next_cursor?: string }>(
        'GET',
        `${base(g)}/members?cursor=${encodeURIComponent(cursor)}`,
        undefined,
        '获取群成员列表',
      )
      return { members: data.members ?? [], nextCursor: data.next_cursor ?? '' }
    },

    member: (g, m) => client.call('GET', `${base(g)}/members/${m}`, undefined, '获取群成员信息'),

    async removeMembers(g, ids, options = {}) {
      if (ids.length > 20) throw new Error('单次最多移除 20 人')
      const data = await client.call<{ add_to_member_blacklist_fail_openids?: string[] }>(
        'POST',
        `${base(g)}/batch_remove_members`,
        { member_openids: ids, ...(options.addToBlacklist ? { add_to_member_blacklist: true } : {}) },
        '移除群成员',
      )
      return { failedBlacklist: data.add_to_member_blacklist_fail_openids ?? [] }
    },

    blacklist: (g) => client.call('GET', `${base(g)}/member_blacklist`, undefined, '查询群黑名单'),

    async updateBlacklist(g, op, ids) {
      if (ids.length > 20) throw new Error('单次最多操作 20 人')
      const data = await client.call<{ fail_openids?: string[] }>(
        'POST',
        `${base(g)}/member_blacklist`,
        { op, member_openids: ids },
        '操作群黑名单',
      )
      return { failed: data.fail_openids ?? [] }
    },

    async mute(g, ops: MuteOp[]) {
      if (ops.length > 20) throw new Error('单次最多设置 20 人')
      const members = ops.map((o) =>
        o.op === 'del'
          ? { op: 'del', member_openid: o.memberOpenid, mute_expire_at: '' }
          : { op: o.op, member_openid: o.memberOpenid, mute_expire_at: toRfc3339(o.expireAt) },
      )
      await client.call('POST', `${base(g)}/restrict_chat_setting`, { members }, '设置禁言')
    },

    muteState: (g) => client.call('GET', `${base(g)}/restrict_chat_setting`, undefined, '查询禁言状态'),

    async joinRequests(g) {
      const data = await client.call<{ join_requests?: JoinRequest[]; list?: JoinRequest[] } | JoinRequest[]>(
        'GET',
        `${base(g)}/join_request_list`,
        undefined,
        '拉取入群申请',
      )
      if (Array.isArray(data)) return data
      return data.join_requests ?? data.list ?? []
    },

    async reviewJoinRequest(g, m, decision, joinRequestId) {
      const body: Record<string, unknown> = { op: decision.approve ? 'approve' : 'decline' }
      if (joinRequestId) body.join_request_id = joinRequestId
      if (!decision.approve) {
        if (decision.reason) body.reject_reason = decision.reason
        if (decision.addToBlacklist) body.add_to_member_blacklist = true
      }
      await client.call('POST', `${base(g)}/approval_join_request/${m}`, body, '审批入群申请')
    },
  }
}
