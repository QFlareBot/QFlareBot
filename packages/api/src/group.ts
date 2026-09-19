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

    async createJoinStrategy(input) {
      const { groupOpenids, groupIds, isEnable, expireAt, remark } = input
      // 二选一：两边都有或都没有都算非法（平台规则）
      const hasOpenids = !!groupOpenids?.length
      const hasIds = !!groupIds?.length
      if (hasOpenids === hasIds) throw new Error('groupOpenids 与 groupIds 二选一必填（互斥，不能同时传或都不传）')
      if ((groupOpenids?.length ?? 0) > 100 || (groupIds?.length ?? 0) > 100) throw new Error('关联群最多 100 个')
      const data = await client.call<{ strategy_id?: string; is_enable?: string; expire_at?: string }>(
        'POST',
        '/v2/groups/join_approval_strategy',
        {
          ...(groupOpenids?.length ? { group_openids: groupOpenids } : {}),
          ...(groupIds?.length ? { group_ids: groupIds } : {}),
          ...(isEnable ? { is_enable: isEnable } : {}),
          ...(expireAt ? { expire_at: toRfc3339(expireAt) } : {}),
          ...(remark ? { remark } : {}),
        },
        '创建入群自动审批策略',
      )
      return {
        strategyId: data.strategy_id ?? '',
        ...(data.is_enable ? { isEnable: data.is_enable } : {}),
        ...(data.expire_at ? { expireAt: data.expire_at } : {}),
      }
    },

    async updateJoinStrategy(strategyId, patch) {
      if (patch.groupAction) {
        const { op, groupOpenids, groupIds } = patch.groupAction
        if (op !== 'add' && op !== 'del') throw new Error('groupAction.op 仅支持 add/del')
        if (!!groupOpenids?.length === !!groupIds?.length) throw new Error('groupAction 的 groupOpenids 与 groupIds 二选一')
      }
      const data = await client.call<{ is_enable?: string; expire_at?: string }>(
        'PATCH',
        `/v2/groups/join_approval_strategy/${strategyId}`,
        {
          ...(patch.isEnable ? { is_enable: patch.isEnable } : {}),
          ...(patch.expireAt ? { expire_at: toRfc3339(patch.expireAt) } : {}),
          ...(patch.remark ? { remark: patch.remark } : {}),
          ...(patch.groupAction
            ? {
                group_action: {
                  op: patch.groupAction.op,
                  ...(patch.groupAction.groupOpenids?.length ? { group_openids: patch.groupAction.groupOpenids } : {}),
                  ...(patch.groupAction.groupIds?.length ? { group_ids: patch.groupAction.groupIds } : {}),
                },
              }
            : {}),
        },
        '修改入群自动审批策略',
      )
      return {
        ...(data.is_enable ? { isEnable: data.is_enable } : {}),
        ...(data.expire_at ? { expireAt: data.expire_at } : {}),
      }
    },

    deleteJoinStrategy: (strategyId) =>
      client.call('DELETE', `/v2/groups/join_approval_strategy/${strategyId}`, {}, '删除入群自动审批策略'),

    executeJoinStrategy: (strategyId) =>
      client.call('POST', `/v2/groups/join_approval_strategy/${strategyId}/execute`, {}, '执行入群自动审批策略'),

    async updateJoinStrategyWhitelist(strategyId, op, qqNumbers) {
      if (op !== 'add' && op !== 'del') throw new Error('op 仅支持 add/del')
      if (!qqNumbers.length || qqNumbers.length > 10000) throw new Error('白名单号码单次 1～10000 个')
      const data = await client.call<{ whitelist_user_count?: number; updated_at?: string }>(
        'POST',
        `/v2/groups/join_approval_strategy/${strategyId}/whitelist_users`,
        { op, whitelist_users: qqNumbers },
        '修改审批策略白名单',
      )
      return {
        ...(data.whitelist_user_count !== undefined ? { whitelistUserCount: data.whitelist_user_count } : {}),
        ...(data.updated_at ? { updatedAt: data.updated_at } : {}),
      }
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
